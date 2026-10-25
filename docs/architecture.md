# Architecture

## Overview

```
 Browser PWA ─┐                         ┌─ Claude Code (Agent SDK subprocess, owner's subscription)
              │ WSS /ws  (cookie)        │      └─ in-process MCP server "jarvis" (per turn)
 ESP32 device ┤ WSS /ws/device (token)   │
              ▼                          │
          Caddy (TLS) ──► server (Fastify) ──► SQLite (WAL, FTS5)  ◄── worker (reminders, outbox, Web Push)
                               │                                   ◄── whatsapp-bridge (optional, Baileys)
                               ├─► STT provider (swappable)
                               └─► TTS provider (swappable)
```

One SQLite database is the source of truth for conversations, memory, agenda, agreements, reminders, messages and integration state. Claude session files are a resumable cache, never the source of truth.

## Processes

| Process | Entry | Responsibility |
| - | - | - |
| server | `apps/server/src/main.ts` | HTTP, auth, WebSocket protocol, turn orchestration, tools, voice pipeline |
| worker | `apps/server/src/worker.ts` | Reminder scheduling, outbox delivery (Web Push), recovery after restarts. Never imports the Claude runtime. |
| whatsapp-bridge | `apps/server/src/whatsapp-bridge.ts` | Optional, disabled by default. Read-only sync of the owner's WhatsApp into `wa_messages`. |

## Reminders worker

- Each tick claims due reminders inside `BEGIN IMMEDIATE`, writes outbox rows with unique dedupe keys (`reminder:<id>:<due_utc>:push|chat`) and advances recurring series in their own zone.
- Downtime policy, applied on every tick: a reminder overdue by at most `REMINDER_GRACE_MINUTES` (default 360) fires once, marked late; older ones are not fired, one-offs become `missed`, recurring ones skip to the next occurrence, and a single digest (push with a count, chat with the list) is sent.
- The dispatcher leases one outbox row at a time, retries with exponential backoff up to 6 attempts, then marks it `dead`. 404/410 prune the subscription. Chat messages are written in the same transaction that closes the row, so they land exactly once; push is at-least-once and the notification tag deduplicates on the device.
- Push payload: `{ title, body, tag, url }`. The body is the reminder text, or "Tenés un recordatorio." when the reminder is sensitive. The server's live feed polls new system messages and emits single-item `history` events.

## Turn lifecycle

1. Client sends `user.text`, or `audio.begin` + binary mic frames + `audio.end`.
2. Voice turns go through `SpeechToTextService` → `transcript` events.
3. `ConversationOrchestrator.startTurn` cancels any running turn in that conversation (one active turn per conversation), persists the user message and registers a per-turn toolset.
4. `ClaudeAgentRuntime.runTurn` resumes the conversation's explicit `claude_session_id` (or starts a fresh session seeded with recent history after `CLAUDE_SESSION_MAX_TURNS`, or when resume fails).
5. Runtime events become protocol events: `assistant.delta`, `tool`, `state`, `card`, `assistant.done`, `turn.end`.
6. For voice replies a `ReplySpeaker` turns text deltas into sentences → TTS → PCM frames tagged with the turn id.
7. Cancellation (`turn.cancel`) aborts the runtime and the speaker. Tool writes already executed stay; their idempotency key prevents duplicates.

## Contracts (`packages/contracts`)

- `states.ts`: `offline, connecting, idle, listening, transcribing, thinking, using_tool, speaking, interrupted, error`. The server may only emit `ServerAssistantState`; the client owns offline/connecting/listening.
- `protocol.ts`: client and server message unions. Every server message carries a per-connection `seq`.
- `audio.ts`: PCM s16le mono, negotiated sample rate. Binary frame = `[kind:1][turnId:16][payload]`.
- `cards.ts`: in-chat cards (youtube, sources, reminder, event, confirm, integration, pairing, push_permission, link).
- `tools.ts`: tool input shapes (`toolInputs`), the `ToolResult` envelope, and the policy sets `untrustedContentTools` and `stateChangingTools`.
- `runtime.ts`: `ModelRuntime` / `RuntimeEvent`, so the model backend can be swapped.

## Security model

- One owner. Password (scrypt) → opaque server-side session cookie (HttpOnly, Secure, SameSite=Strict). Origin checked on WebSocket upgrades and mutating requests.
- The Claude subprocess gets an allowlisted environment: no API keys, no server secrets. `settingSources: []`, `strictMcpConfig`, claude.ai connectors disabled, `permissionMode: dontAsk`, built-ins limited to `WebSearch`, and a `PreToolUse` hook that denies anything outside the per-turn allowlist.
- Tool policy (`tools/runner.ts`): zod validation (strict), idempotent writes keyed by turn + tool + input, and taint tracking. After a turn reads untrusted content, state-changing tools create a pending action and a confirm card; only the owner's tap executes the stored input, without the model.
- Tokens for Google and WhatsApp are encrypted at rest with a key separate from the database.

## Data model (migration 001)

conversations, turns (with latency metrics), messages (+FTS), memories (+FTS) and memory_events (audit; text scrubbed on forget), contacts, contact_aliases, contact_identities, agreements, agreement_parties, agreement_events, calendar_events, reminders, outbox, push_subscriptions, auth_sessions, devices, oauth_accounts, oauth_states, wa_chats, wa_messages (+FTS), wa_sync_state, wa_auth_state, tool_executions (idempotency), pending_actions.

Timestamps are stored as UTC ISO strings; anything recurring also stores the IANA zone.

## Verified Claude route (2026-10-24)

`apps/server/scripts/claude-probe.ts` against the real service with the owner's local login: authenticated query, follow-up with context via explicit `resume`, progressive text deltas, an in-process MCP tool call, Bash denied, context fingerprint returned, cancellation and recovery, and invalid resume mapped to `resume_failed`. `apiKeySource` reported `none` (subscription OAuth, no API key). See `docs/claude-runtime.md`.
