# Claude runtime

## Route and policy (checked 2026-10-24)

- Anthropic's support article "Use the Claude Agent SDK with your Claude plan" (updates of 2026-06-15 and 2026-10-07) states that the Agent SDK, `claude -p` and third-party apps keep running against subscription limits. This can change; the runtime is behind `ModelRuntime` so the backend can be swapped without touching transport or voice.
- Claude Code legal page: subscription OAuth is for ordinary, individual use, and the binary must run unmodified. J.A.R.V.IS is a single-owner deployment where the owner signs in to the unmodified Claude Code binary with their own subscription. It does not offer Claude login to anyone else.
- Authentication on a server: `claude setup-token` (run by the owner, browser flow) prints a one-year OAuth token, set as `CLAUDE_CODE_OAUTH_TOKEN`. `--bare` does not read OAuth or that variable, so it is not used.
- Precedence: `ANTHROPIC_API_KEY` would win over the subscription in `-p` mode. The runtime builds the subprocess environment from an allowlist, so API keys never reach it and paid API usage cannot be activated silently.
- Paid overage: `rate_limit_event` messages report `isUsingOverage`; the turn is stopped unless `CLAUDE_ALLOW_OVERAGE=true`.

## Plans and authentication (checked 2026-11-20)

Sources, read on 2026-11-20:

- [claude.com/pricing](https://claude.com/pricing)
- Help Center: [Monthly API credits for Max, Ultra and Team plans](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans)
- Help Center: [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) (updates of 2026-06-15 and 2026-10-07)
- Help Center: [Use Claude Code with your Pro, Max or Ultra plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan)
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- Anthropic, [updates to the consumer terms](https://www.anthropic.com/news/updates-to-our-consumer-terms)

| Plan | Price | Usage | API credits included |
| --- | --- | --- | --- |
| Pro | USD 20 per month (17 per month billed yearly) | 1x; 5-hour and weekly limits | none |
| Max | USD 100 per month | 5x Pro; 5-hour and weekly limits, plus a separate weekly Fable limit | USD 100 per month on the Claude Platform |
| Ultra | USD 200 per month | 10x Pro weekly; no 5-hour limit on verified accounts | USD 200 per month |

What the pages say, and what it means here:

- **Subscription login.** When signed in with the plan, the Agent SDK and `claude -p` draw from the plan's usage limits. Those limits are shared with claude.ai and with the owner's own Claude Code, and they "assume ordinary, individual usage of Claude Code and the Agent SDK". Max is not unlimited.
- **Monthly API credits (Max and Ultra).**
  - They cover the Messages API, Managed Agents, and the Agent SDK and `claude -p` *when run with an API key* from the Console organization linked to the plan (Settings > Billing > API credits > Link organization; one organization, changed only through support).
  - They work with any available model.
  - They expire at the end of each billing cycle.
  - They need no card. Without purchased credits or auto-reload, requests stop when the credits run out; usage is never charged to the plan.
  - They do not apply to interactive Claude Code or to the plan's usage credits.
- **API key for products.** Developers building products on the Agent SDK should use API key authentication. Anthropic does not allow offering Claude.ai login, or routing requests through plan credentials, on behalf of others. J.A.R.V.IS has a single owner who signs in to the unmodified binary with their own subscription, which the page explicitly does not restrict.
- **Data.** Pro and Max chats and coding sessions follow the Consumer Terms: they can be used for training unless the owner opts out, with exceptions for feedback and safety review. API usage follows the Commercial Terms, and prompts are not used for training.

### Chosen mode (owner decision, 2026-11-21)

Everything runs on the owner's subscription. No API key is read or forwarded anywhere, and the API credits included with Max stay unused.

| Traffic | Authentication | Notes |
| --- | --- | --- |
| Personal chat (server runtime) | Subscription OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`), validated on 2026-10-24 | Unchanged. |
| Delegated work (agent runner) | A second subscription token from `claude setup-token` (`AGENT_CLAUDE_CODE_OAUTH_TOKEN`), only in `/etc/jarvis/agents.env` | Validated on 2026-11-21 with the local login: the controlled task cost USD 0.11 of estimated usage and the session reported the plan windows. |

What this implies, and how the runner limits it:

- **Shared limits.** Agents draw from the same 5-hour and weekly limits as the chat and the owner's own Claude Code. The runner keeps a reserve for the chat: when a session reports that any plan window passed `AGENT_PLAN_MAX_UTILIZATION` (default 0.7), no new phase starts until that window resets, and the owner gets one notice. See [agents.md](agents.md#plan-reserve).
- **Lower consumption by default.** Concurrency 1, the planner on Haiku (USD 0.003 per plan in the real runs, with criteria as good as Sonnet's on the controlled task), a read-only Haiku explorer, per-session and per-task budgets, and at most 2 fix rounds.
- **Budgets are estimates.** `total_cost_usd` is the SDK's API-equivalent estimate. On the subscription nothing is charged per task; the USD figures only cap how much of the plan a task may use.
- **No paid overage.** The chat stops on `isUsingOverage` unless `CLAUDE_ALLOW_OVERAGE=true`. The runner ends the session as soon as the plan refuses requests or overage starts. Keeping extra usage disabled on the account makes that a hard guarantee. On 2026-11-21 the account reported overage as rejected.
- **Data.** Subscription sessions follow the Consumer Terms. The owner confirmed on 2026-11-21 that the company allows its code and data to be processed with Claude. Turning off model training in claude.ai privacy settings is still recommended.
- **Ordinary, individual usage.** Plan limits assume it. A single owner delegating their own work at concurrency 1 fits that reading, but sustained background automation is the part Anthropic could judge otherwise. If that happens, the switch is configuration only: the backend sits behind `AgentBackend`.

Alternatives considered and set aside:

- **API key with the Max credits.** It needs no card and has a hard cap, Commercial Terms and separate limits. The owner chose not to use any API.
- **OpenRouter.** It is a pay-per-token API with its own billing. It does not use the plan, and Claude there costs the same per token. Cheaper models would mean leaving Sonnet and Haiku, and sending company code to more third parties.
- **Managed Agents.** It moves execution off the box and bills by session runtime. Postponed.

## Adapter (`apps/server/src/runtime/claude-runtime.ts`)

| Requirement | Implementation |
| - | - |
| Start a turn | `query()` with a string prompt, custom system prompt (`snapshot: false` so profile edits apply) |
| Resume by explicit id | `resume: conversations.claude_session_id`; no `--continue` |
| Partial text | `includePartialMessages: true`, `stream_event` → `content_block_delta/text_delta` from the main thread only |
| Authorized tools only | `tools: ["WebSearch"]`, in-process MCP server `jarvis` per turn, `allowedTools`, `disallowedTools`, `permissionMode: "dontAsk"`, `PreToolUse` hook allowlist, `settingSources: []`, `strictMcpConfig`, `disableClaudeAiConnectors` |
| Cancellation | `AbortController` + iteration that stops on abort without waiting for the next message, then `close()` |
| Quota and errors | `rate_limit_event` (rejected / overage), assistant `error` codes, result error subtypes, `resume_failed` detection |
| Session persistence | `conversations.claude_session_id` + `session_turns`; rotation after `CLAUDE_SESSION_MAX_TURNS` turns, `CLAUDE_SESSION_MAX_CONTEXT_TOKENS` of context in the last call or `CLAUDE_SESSION_IDLE_MINUTES` idle; the seed is the SQLite summary (`conversations.summary`, built in the background by a tool-less Haiku call from the messages after `summary_through_rid`) plus the messages it does not cover. Per-turn token usage is stored in `turns` |
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

## Model

The assistant defaults to `claude-sonnet-5-5` (`CLAUDE_MODEL`), chosen by the owner on 2026-10-24: it shares the subscription quota with the owner's own Claude Code usage, the turns are short and tool-driven, and it measured as fast as Opus 5.5 with a much tighter p95. The probe results below were taken with the account default (Opus 5.5) before that change.

## Latency bench

Command: `pnpm --filter @jarvis/server exec tsx scripts/claude-latency.ts 5 low` (real service, owner login, `replyMode: voice`). Measured 2026-10-24 on the development machine while six other build agents were running on it, so the p95 values include local CPU contention and are pessimistic.

| Case (n = 5) | First text p50 | First text p95 | Total p50 | Total p95 |
| - | - | - | - | - |
| New session, simple | 1.93 s | 9.29 s | 2.69 s | 16.27 s |
| Resumed, simple | 1.98 s | 5.21 s | 3.07 s | 5.40 s |
| Resumed, one tool call | 4.31 s | 4.65 s | 4.33 s | 4.70 s |

These are Claude-only numbers. End-to-end voice latency adds STT before and TTS after, and is measured per turn in the `turns` table. Tool turns are slower because the model answers after the tool round trip; a short spoken acknowledgement is not emitted on purpose (provisional text is not read aloud).

Same bench with the new default, `claude-latency.ts 5 low claude-sonnet-5-5`, measured 2026-10-25 02:22 UTC while four build agents ran on the machine:

| Case (n = 5) | First text p50 | First text p95 | Total p50 | Total p95 |
| - | - | - | - | - |
| New session, simple | 2.07 s | 2.30 s | 2.55 s | 3.00 s |
| Resumed, simple | 2.13 s | 2.58 s | 2.84 s | 2.94 s |
| Resumed, one tool call | 4.27 s | 4.73 s | 4.44 s | 4.80 s |

## Plan usage in Configuración

Configuración shows how much of the Claude plan is used: the 5-hour session window and the weekly one, each with its reset time (`GET /api/usage`, `apps/server/src/runtime/plan-usage.ts`).
- The long-lived token from `claude setup-token` cannot call Anthropic's usage endpoint: it lacks the `user:profile` scope.
- Every Messages response carries the plan's `anthropic-ratelimit-unified-5h-*` and `-7d-*` headers, so the server asks Haiku for one token and reads them. The answer is cached for two minutes.
