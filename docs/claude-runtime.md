# Claude runtime

## Route and policy (checked 2026-10-24)

- Anthropic's support article "Use the Claude Agent SDK with your Claude plan" (updates of 2026-06-15 and 2026-10-07) states that the Agent SDK, `claude -p` and third-party apps keep running against subscription limits. This can change; the runtime is behind `ModelRuntime` so the backend can be swapped without touching transport or voice.
- Claude Code legal page: subscription OAuth is for ordinary, individual use, and the binary must run unmodified. J.A.R.V.IS is a single-owner deployment where the owner signs in to the unmodified Claude Code binary with their own subscription. It does not offer Claude login to anyone else.
- Authentication on a server: `claude setup-token` (run by the owner, browser flow) prints a one-year OAuth token, set as `CLAUDE_CODE_OAUTH_TOKEN`. `--bare` does not read OAuth or that variable, so it is not used.
- Precedence: `ANTHROPIC_API_KEY` would win over the subscription in `-p` mode. The runtime builds the subprocess environment from an allowlist, so API keys never reach it and paid API usage cannot be activated silently.
- Paid overage: `rate_limit_event` messages report `isUsingOverage`; the turn is stopped unless `CLAUDE_ALLOW_OVERAGE=true`.

## Adapter (`apps/server/src/runtime/claude-runtime.ts`)

| Requirement | Implementation |
| - | - |
| Start a turn | `query()` with a string prompt, custom system prompt (`snapshot: false` so profile edits apply) |
| Resume by explicit id | `resume: conversations.claude_session_id`; no `--continue` |
| Partial text | `includePartialMessages: true`, `stream_event` → `content_block_delta/text_delta` from the main thread only |
| Authorized tools only | `tools: ["WebSearch"]`, in-process MCP server `jarvis` per turn, `allowedTools`, `disallowedTools`, `permissionMode: "dontAsk"`, `PreToolUse` hook allowlist, `settingSources: []`, `strictMcpConfig`, `disableClaudeAiConnectors` |
| Cancellation | `AbortController` + iteration that stops on abort without waiting for the next message, then `close()` |
| Quota and errors | `rate_limit_event` (rejected / overage), assistant `error` codes, result error subtypes, `resume_failed` detection |
| Session persistence | `conversations.claude_session_id` + `session_turns`; rotation after `CLAUDE_SESSION_MAX_TURNS` with a seed of recent messages from SQLite |
| Concurrency | One active turn per conversation (`ConversationOrchestrator`), superseded turns are aborted first |
| Current date | A `[contexto: …]` header in every user message, so resumed sessions resolve "mañana" against the real local date |

## Live probe results

Command: `pnpm --filter @jarvis/server probe:claude <report.json>` with the owner's local login. Report kept outside Git.

| Check | Result |
| - | - |
| Authenticated query | pass; `apiKeySource: "none"` (subscription OAuth), model `claude-opus-5-5` |
| Tools exposed | `WebSearch` + `mcp__jarvis__*` only; MCP servers: `jarvis` only |
| Follow-up with context (explicit resume) | pass ("47") |
| Progressive response | pass; 59 text deltas, first at 1.48 s, total 4.39 s |
| Innocuous MCP tool (`integrations_status`) | pass; handler executed once |
| Bash requested | not available; no tool call |
| Context fingerprint | pass; model returned the fingerprint of `assistant/CLAUDE.md` + profile |
| Cancellation and recovery | pass; after a fix, output stops 2 ms after abort and the same session resumes |
| Invalid session id | mapped to `resume_failed` in 0.34 s |

Latency observed (effort `low`, Opus 5.5, local machine, Buenos Aires): first text 1.5–1.9 s for new sessions, about 3.4 s on resume. Each turn spawns a Claude Code process; keeping a streaming-input process per conversation is a planned optimization.

## Latency bench

Command: `pnpm --filter @jarvis/server exec tsx scripts/claude-latency.ts 5 low` (real service, owner login, `replyMode: voice`). Measured 2026-10-24 on the development machine while six other build agents were running on it, so the p95 values include local CPU contention and are pessimistic.

| Case (n = 5) | First text p50 | First text p95 | Total p50 | Total p95 |
| - | - | - | - | - |
| New session, simple | 1.93 s | 9.29 s | 2.69 s | 16.27 s |
| Resumed, simple | 1.98 s | 5.21 s | 3.07 s | 5.40 s |
| Resumed, one tool call | 4.31 s | 4.65 s | 4.33 s | 4.70 s |

These are Claude-only numbers. End-to-end voice latency adds STT before and TTS after, and is measured per turn in the `turns` table. Tool turns are slower because the model answers after the tool round trip; a short spoken acknowledgement is not emitted on purpose (provisional text is not read aloud).
