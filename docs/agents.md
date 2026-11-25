# Delegated work (agents)

J.A.R.V.IS has two jobs from now on: the personal assistant it already was, and the control point for work tasks that agents do in the background. The owner talks to one assistant; the delegation machinery is invisible.

Status words follow the project vocabulary. Everything in this document is *implemented* and *tested with fixtures* unless a line says otherwise.

## Decision: conversational interface plus a deterministic runner

Two options were evaluated:

- **A. JARVIS orchestrates directly.** The chat agent would run long work inside its own turn.
- **B. JARVIS is the interface to an internal orchestrator.**

**B was chosen, with the orchestrator written as ordinary software instead of another model layer.**

Why not A:

- A long task inside a chat turn blocks quick questions.
- The work dies with the turn, the WebSocket or the session, and cannot survive a restart.
- It mixes personal and work context in one session.
- It would need shell and filesystem tools in the production assistant, which `CLAUDE.md` forbids.

Why the orchestrator is code:

- The queue, leases, limits, retries, de-duplication, recovery and notifications are deterministic, so code owns them.
- The models do what needs judgement: write the acceptance criteria (planner), do the work (executor) and check it (reviewer).
- No orchestrator LLM sits between JARVIS and the agents. That is one less layer, one less cost and one less place to lose context.

## Components

```
 Phone (PWA) ──WSS──► server ── chat runtime (Sonnet, subscription) ── tools task_*  ──┐
                        │                                                              │ writes
                        ├── /api/tasks/attachments, /diff, /files (owner only)         ▼
                        │                                                  work.db  (work volume /work)
 worker ── TaskNotifier: task events ─► outbox (jarvis.db) ─► chat message + Web Push    ▲
                                                                                       │ claims, updates
 agent-runner (separate container, no personal volume) ─ TaskRunner ─ Agent SDK ───────┘
        └─ per task: plan (Haiku) → execute (Sonnet, subagent Haiku) → review (Sonnet, fresh session)
```

| Piece | Code | Notes |
| --- | --- | --- |
| Task store | `apps/server/src/tasks/task-store.ts`, migrations in `db/work-migrations/` | `work.db` is a separate SQLite file. The runner never mounts `jarvis.db`. |
| Runner (state machine) | `tasks/task-runner.ts`, entry `src/agent-runner.ts` | Polls every 3 s and costs nothing while idle. |
| Agent backend | `tasks/claude-agent-backend.ts` | Agent SDK with an explicit model, tool list, sandbox and path policy per role. |
| Owner operations | `tasks/task-service.ts` | Create, feedback, pause, resume, cancel, retry, accept and approvals. It never runs agents. |
| Chat tools | `tools/task-tools.ts` | `task_create`, `task_projects`, `task_list`, `task_status`, `task_result`, `task_feedback`, `task_control` |
| Card taps | `task.action` WebSocket message | Pause, resume, cancel, accept, approve and reject reach `TaskService` without the model. |
| Notifications | `tasks/task-notifier.ts` in the worker | Only events that need the owner: ready, question, approval, review limit, budget, first usage limit, failure. |
| Workspaces | `tasks/workspace.ts` | `/work/tasks/<id>/{request,context,work,.runner}`. Each workspace has its own git repository with a baseline commit. |
| Status | `tasks/agents-status.ts` | `integrations_status` reports whether the runner wrote a heartbeat in the last 2 minutes. |

## Lifecycle

| Status | Who acts | Meaning |
| --- | --- | --- |
| `queued` (phase plan, execute or review) | runner | Waits for a free slot, or for `not_before` after a backoff or usage limit |
| `running` | runner | One leased run. A partial unique index forbids a second active run for the same task. |
| `awaiting_owner` | owner | A blocker: `question`, `approval`, `review_limit`, `budget`, `usage_limit` or `error` |
| `ready` | owner | The reviewer approved every criterion with its own evidence |
| `accepted`, `failed`, `cancelled` | — | Final. Feedback can reopen an accepted or failed task. |

Phase rules:

1. **Plan.** The planner reads the request, attachments and project context (read-only). It returns the goal, deliverables, 1 to 8 verifiable criteria, assumptions, blocking questions and external effects. With blocking questions the task waits for the owner, and the answer triggers a new plan.
2. **Execute.** The executor works in the task's repository. It resumes its previous session when it can, or starts fresh from the state in `work.db` when it cannot. Its guidance is the reviewer's required changes plus the owner's feedback. After it finishes, the runner commits the work and measures `git diff` against the baseline itself.
3. **Review.** A separate session runs in a disposable clone. It gets:
   - the original request, verbatim;
   - the criteria;
   - the diff measured by the runner;
   - the executor's report, labelled as claims to check.

   It returns pass, fail or unverified for each criterion, with evidence. The verdict is approve, changes or blocked.
4. **Changes.** Up to `AGENT_MAX_FIX_ROUNDS` (default 2) automatic fix rounds. After that the task waits for the owner with the reviewer's summary.

Owner feedback sent while a task runs is queued for the next iteration. If the reviewer approves while feedback is pending, the task goes back to execution instead of becoming `ready`.

## Roles, models and tools

| Role | Model (default) | Tools | Writes |
| --- | --- | --- | --- |
| Planner | `claude-sonnet-5-5`, effort medium | Read, Glob, Grep, WebSearch, WebFetch | nothing |
| Executor | `claude-sonnet-5-5`, effort medium | Read, Write, Edit, Glob, Grep, Bash, TodoWrite, WebSearch, WebFetch, Agent (only `explorer`) | its `work/` folder |
| Explorer subagent | `claude-haiku-5-5` | Read, Glob, Grep | nothing |
| Reviewer | `claude-sonnet-5-5`, effort medium | Read, Glob, Grep, Bash, TodoWrite | a disposable clone |

The planner moved to Haiku on 2026-11-21 to spend less of the plan. On the controlled task, with real Claude, it wrote 7 verifiable criteria (including the rounding rule from `CONTEXT.md` and a scope check) for USD 0.003. On 2026-11-25 the owner moved it back to Sonnet, because whole projects and research need stronger plans. `AGENT_MODEL_PLANNER=claude-haiku-5-5` brings Haiku back.

Network, decided by the owner on 2026-11-25:
- Agent commands reach package registries (npm, Yarn, JSR, PyPI) and GitHub (`DEFAULT_AGENT_DOMAINS` in `runner-config.ts`, overridden by `AGENT_ALLOWED_DOMAINS`). So agents can install dependencies and clone public code.
- The planner and the executor have WebSearch and WebFetch for research. These tools follow the tool allowlist, not the domain list.
- Agents still get no credentials: anything that writes to GitHub or deploys is done by the server after an owner tap.

No delegation can end up on Opus. The guard has six layers:

1. The runner refuses to start if any configured model is not Sonnet or Haiku.
2. Every role and the subagent have an explicit model. `CLAUDE_CODE_SUBAGENT_MODEL` is set.
3. Claude Code's `availableModels` setting is `["sonnet", "haiku"]`.
4. A `PreToolUse` hook only allows `subagent_type: explorer`. It rejects any model override outside Sonnet and Haiku, remote isolation, and background runs.
5. After each run, the models reported in `modelUsage` are checked. Any other model stops the task with a `model_policy` error.
6. No `fallbackModel` is configured.

## Limits

All limits are enforced by the runner, not by prompts.

| Limit | Default | Variable |
| --- | --- | --- |
| Concurrent runs | 1 | `AGENT_CONCURRENCY` (max 4) |
| Budget per task (estimate) | USD 5 | `TASK_DEFAULT_BUDGET_USD` on the server |
| Budget per run | USD 2, or what is left of the task budget | `AGENT_RUN_BUDGET_USD` (SDK `maxBudgetUsd`) |
| Turns per run | 20 planner, 80 executor, 40 reviewer | `AGENT_MAX_TURNS_*` |
| Wall-clock per run | 30 min | `AGENT_RUN_TIMEOUT_MINUTES` |
| Automatic fix rounds | 2 | `AGENT_MAX_FIX_ROUNDS` |
| Attempts after transient failures | 3, with backoff of 30 s, 60 s and 120 s | `AGENT_MAX_ATTEMPTS` |
| Plan reserve | no new phase once any plan window passes 70 %, until it resets | `AGENT_PLAN_MAX_UTILIZATION` (0.1 to 1) |
| Usage limit | the session stops; every agent waits until the reported reset (30 min if unknown); after 3 attempts the task asks the owner | — |

The cost figures are the SDK's `total_cost_usd`, an estimate at API list prices. On the subscription nothing is charged per task: budgets cap how much of the plan a task may use.

### Plan reserve

Agents share the owner's subscription limits with the chat, so the runner keeps headroom for the chat:

- Each session records the most used plan window it saw (`task_runs.plan_utilization`, a fraction). It is read from the documented rate-limit fields and, when the CLI sends it, from the per-window detail. On 2026-11-21 that detail reported the 5-hour and weekly windows.
- When that value reaches `AGENT_PLAN_MAX_UTILIZATION`, the runner stores a hold in `work.db` until that window resets. No phase starts until then, for any task, and the hold survives restarts. The owner gets one chat message and push, for example "Pausé los agentes hasta las 14:00 del viernes".
- A refused request or the start of paid overage ends the session at once. It also sets the hold until the reported reset.
- No session starts while the hold is active, and a running session is interrupted as soon as a rate-limit event shows the reserve was crossed. The task waits for the reset without using an attempt and keeps its session. A session that is interrupted, times out or is cancelled still records the cost the SDK reports at that point.
- `task_create` and the integrations status tell JARVIS when agents are on hold.
- Because a weekly window can take days to reset, raise the threshold (or set it to 1) if the hold blocks work you need. To release an active hold right away, see the runbook.

## Continuity and recovery

- **Sessions are a cache.** The request, spec, report, review, evidence, feedback, blocker, cost and iteration live in `work.db`. A lost planner or executor session restarts from that state; `resume_failed` clears the session id. The planner resumes its own session for the owner's answers and for retries. The executor resumes its session for retries and for the first fix round; a later fix round starts a fresh session seeded with the plan and the reviewer's findings, and a retry inside that round resumes the round's own session. The reviewer gets only the diff since the last completed review (`refs/jarvis/reviewed` in the work repo; the baseline before the first one), without lockfiles or generated files, capped at 12,000 characters.
- **Leases.** Every run holds a 2-minute lease, renewed every 15 s. On start, the runner interrupts every run left as `running` by a previous process and puts its task back in the queue with one more attempt. Repeated interruptions end in `failed`.
- **Duplicates.**
  - Claiming is a single `BEGIN IMMEDIATE` transaction. The partial unique index blocks a second active run for the same task.
  - `task_create` inherits the chat tool idempotency key (turn + input).
  - External sources de-duplicate on `(source, external_ref)`.
  - Notifications de-duplicate on `task-event:<id>:chat|push`.
- **External effects.** Agents have no credentials for company systems, and their network reaches only registries, GitHub and the web for reading, so re-running a phase only touches the task's own folder. Any future connector that writes outside the workspace must record the effect with an idempotency key and check its outcome before retrying. Until then, an `unknown` outcome is never retried automatically.

## Personal and work separation

| | Personal (chat) | Work (agents) |
| --- | --- | --- |
| Database | `jarvis.db` on `jarvis-data` | `work.db` on `work-data` |
| Process and container | server, worker, bridge | `agent-runner`, on its own Docker network |
| Claude credentials | owner subscription (`CLAUDE_CODE_OAUTH_TOKEN`) | a second subscription token for agents only (`AGENT_CLAUDE_CODE_OAUTH_TOKEN`) |
| Secrets in reach | Google tokens, VAPID, voice keys | only the agent token; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` strips it from tool subprocesses |
| Context | profile, memories, integrations | the request, its attachments, the project's `CONTEXT.md` and its repository |

JARVIS is told not to copy personal data into a task request unless the owner asks. Task results that come back to the chat are third-party content: `task_status` and `task_result` taint the turn, so a state change in the same turn needs a confirmation card. `task_create`, `task_feedback` and `task_control` are state-changing tools, so a turn that read an email cannot spawn work silently.

Inside the runner container:

- File tools are confined by the path policy: reads only in the task's `request/`, `context/` and `work/` (or system paths); writes only in `work/`. Nothing under `/proc`, `/sys` or `/dev`, other tasks, `.runner/` or `work.db`.
- Bash runs in Claude Code's sandbox (bubblewrap), with `failIfUnavailable` in production.
- **Residual risk (documented, not solved):** with the weaker nested sandbox Docker needs, a hostile command could read the agent process environment through `/proc` and use an allowed domain to exfiltrate the agent token. The token would expose the owner's plan usage, not money while extra usage stays disabled, until it is revoked. It is a separate token from the chat's, so it can be revoked and replaced with `claude setup-token` without touching the chat. Since 2026-11-25 agents have network by the owner's decision, so this risk is accepted. Set `AGENT_ALLOWED_DOMAINS` empty and drop WebFetch to close it.

## Approvals and external effects

- A finished task never gets permission to publish, deploy or send anything. The runner has no such capability.
- The one exception is build mode ([build-mode.md](build-mode.md)). There, a reviewed change to JARVIS itself is published only after the owner taps Publish. The publisher is deterministic and runs on the host; no agent is involved.
- When the executor needs an external action, it reports `approvalsNeeded`. The task then waits with an `approval` blocker that names the exact action, and the card shows Approve and Reject.
- The decision is recorded once (`task_approvals`), by a tap, never by the model. It reaches the executor as a system-written note.
- In this version an approved action is still executed by the owner, from the instructions the agent leaves. A future connector will execute stored, approved actions deterministically, like `pending_actions` in the chat.

## Owner interface

- **Chat.** "Revisá esta tarea y resolvela", "¿cómo viene la 3?", "mostrame el resultado", "corregí esto": the assistant prompt maps these to the task tools (`assistant/CLAUDE.md`).
- **Card.** Status, phase, iteration, blocker, reviewer score (criteria passed out of total), deliverables, estimated cost and budget, plus a "ver cambios" link. Buttons are shown only when they make sense: pause or resume, cancel, approve or reject, accept.
- **Attachments.** The composer's clip button uploads files and screenshots to `POST /api/tasks/attachments` (owner session, 10 MB, stored in `/work/inbox`). It then adds `[adjunto <id> <name>]` to the message, and JARVIS passes the ids to `task_create`.
- **Previews.** `GET /api/tasks/:ref/diff` and `GET /api/tasks/:ref/files?path=`. They are owner-only and confined to the task's `work/` folder (never `.git`). They are served as plain text, images or PDF, never HTML or script.
- **Notifications.** A chat message with the task card, plus a Web Push whose body only says "La tarea #N …".

## Future company integration

Nothing was built for systems that are not known yet. The prepared interface is `TaskStore.create({ source, externalRef, title, request, project, attachmentIds })`:

- it is idempotent per `(source, external_ref)`;
- it goes through the same queue, limits, review and notifications as manual tasks.

A connector for the company's own app would:

- authenticate as that app documents;
- map an assignment to that call;
- report status back only as an approval-gated external effect.

If the company systems need a VPN, another operating system or a different network, that connector runs as its own container or host. It is the only justified exception to the single box, and it is decided when the access is known.

## Claude usage mode

See [`claude-runtime.md`](claude-runtime.md#plans-and-authentication-checked-2026-11-20).

- Chat and agents both run on the owner's subscription, with separate tokens. No API key is used.
- Agents share the plan limits with the chat. The plan reserve, concurrency 1 and the budgets keep them from using up the chat's quota.
- Subscription sessions follow the Consumer Terms: turn off model training in claude.ai privacy settings before sending company material.
- Paid overage cannot start silently: the session stops at the first sign of it.

## Controlled test

`pnpm --filter @jarvis/server demo:tasks` runs a synthetic task: fix a discount bug in `fixtures/synthetic/work/projects/facturacion-demo`, add tests, validate the range and write `CHANGES.md`.

`checkControlledCriteria` checks the four criteria by executing code:

1. 1000 with 10 % discount gives 1089.
2. `node --test` is green and covers 0, 10 and 100 %.
3. A discount outside 0 to 100 throws `RangeError`.
4. `CHANGES.md` exists.

| Run | Result | Status |
| --- | --- | --- |
| Scripted agents (`task-flow.test.ts`, `demo:tasks`) | The first execution skips criteria 3 and 4 but claims everything is done. The scripted reviewer runs the real checks, rejects with evidence, the second execution fixes it, and the task ends `ready`, 4/4. The independent check passes 4/4. | tested with fixtures |
| Real Claude, sandbox required (`--claude`) | Stopped before running anything: "Sandbox required but unavailable". Ubuntu's AppArmor blocks unprivileged user namespaces on the development machine. 0 turns, USD 0. | fail-closed confirmed |
| Real Claude, file tools only (`AGENT_BASH=false`), first try | The policy hook denied the SDK's internal `StructuredOutput` tool, so the planner's output was rejected and queued for retry (USD 0.11). Fixed by always allowing that tool. | bug found and fixed |
| Real Claude, file tools only, after the fix | Planner, executor and reviewer ran on `claude-sonnet-5-5`: 45 s and USD 0.19 estimated. The executor's code is correct (independent check 4/4). The reviewer read it, found it correct, and refused to approve because it could not run `node --test`. The task waits for the owner. | validated with real service (without Bash) |
| Real Claude, file tools only, Haiku planner (2026-11-21) | Haiku planned (7 criteria, USD 0.0035), Sonnet executed and reviewed: 41 s, USD 0.14 estimated, independent check 4/4. The reviewer refused to approve without running tests. | validated with real service (without Bash) |
| Real Claude, file tools only, shipped defaults (2026-11-21) | Same result: 45 s, USD 0.11 estimated, independent check 4/4. Every session recorded the plan at 22 % (weekly window). | validated with real service (without Bash) |
| Production VPS, host runner, Bash in the sandbox (2026-11-21) | The first try exposed the `/run/containerd` mount problem: agents could not run commands and the reviewer refused to approve. After the fix, the task ended `ready` with the reviewer approving 6/6 criteria it checked by running `node --test`. About 1 minute, USD 0.12 estimated. | validated with real service |

Pending: a real run with Bash inside the sandbox. It needs a host where bubblewrap can create user namespaces: the VPS, or this machine with the AppArmor profile from the Claude Code sandboxing docs.

## The Bash sandbox on the target host

Measured on the development machine (Ubuntu with `kernel.apparmor_restrict_unprivileged_userns=1`, Docker with its default profiles), using the `agent-runner` image built from this repository:

| Where bubblewrap runs | Result |
| --- | --- |
| Host, unprivileged user | blocked: `setting up uid map: Permission denied` |
| Container with the default seccomp profile | blocked: `No permissions to create a new namespace` |
| Container with seccomp disabled (diagnostic only) | the namespace is created, then the mount fails: `Failed to make / slave` |

The runner checks this when it starts. With Bash enabled and the sandbox required, it refuses to start and logs the exact error instead of failing task by task.

Measured on the VPS (Debian 13.7, 2026-11-21), in the same order:

| Where bubblewrap runs | Result |
| --- | --- |
| Host, unprivileged user | works |
| Container with the default seccomp profile | blocked: `No permissions to create a new namespace` |
| Container with seccomp and AppArmor unconfined (diagnostic only) | blocked: `Can't mount proc on /proc` |

**Decision: the runner runs as a host service.** `infra/agents/install-host-runner.sh` sets it up:
- user `jarvis-agents`, UID 10001 like the containers' user, with no access to the personal volume, `jarvis.env` or the Docker socket;
- the app and the Node binary are copied from the `jarvis-agent-runner:<tag>` image, so the host runs exactly what was built and tested;
- `/srv/jarvis/work` replaces the `work-data` volume; server, worker, bridge and backup bind-mount it through `infra/agents/compose.host-runner.yml`;
- a hardened systemd unit: read-only system, write access only to the work area, private `/tmp` and devices, memory, CPU and task limits, and a lower CPU and I/O priority (`Nice=10`, `CPUWeight=20`) so agent work never starves the voice server.

Hardening details that matter:
- `ProtectKernelTunables`, `ProtectKernelLogs` and `RestrictSUIDSGID` each break bubblewrap ("Function not implemented"), so the unit leaves them out.
- Claude Code's sandbox masks known sockets, and bubblewrap cannot create the mount point under the root-only `/run/containerd`. The unit mounts an empty tmpfs there (`TemporaryFileSystem=/run/containerd:ro`), so for agents the socket does not exist at all.

The other two options are kept for other hosts: a seccomp profile for the container (not enough on this host), or `AGENT_BASH=false` (agents edit but cannot execute; the reviewer then refuses to approve what only execution proves).

Do not set `AGENT_SANDBOX_REQUIRED=false` in production. It exists for development; inside the runner container, unsandboxed Bash would reach every task's folder and `work.db`.

## Operating

```bash
# development: server with tasks enabled, plus a runner using the local Claude login
WORK_DIR=../../data/work RUNTIME=scripted OWNER_PASSWORD_HASH='<hash>' pnpm --filter @jarvis/server dev
WORK_DIR=../../data/work pnpm --filter @jarvis/server exec tsx src/agent-runner.ts

# controlled test
pnpm --filter @jarvis/server demo:tasks                 # scripted agents
AGENT_BASH=false pnpm --filter @jarvis/server demo:tasks --claude report.json   # real Claude, no command execution

# production: profile "agents" and /etc/jarvis/agents.env (template: infra/agents/agents.env.example)
COMPOSE_PROFILES=agents docker compose up -d agent-runner
```

## Known gaps

- Memory per Claude Code process was not measured. The 4 GB sizing in `costs.md` is an estimate.
- How much of the plan a real task uses is unknown; only the controlled task was measured. `task_runs.plan_utilization` over the first real tasks answers it.
- The plan reserve reads each window's usage from a field the CLI sends but does not document. If a release drops it, the reserve falls back to the documented warning levels, which the server sets.
- Approved external actions are executed by the owner; there is no connector yet.
- The web card shows the latest state but no history timeline; `task_status` lists recent events.
- Task workspaces are not backed up, only `work.db`. Export accepted deliverables you want to keep.
- One runner process is assumed. Two runners would still not duplicate a run, but recovery on start would interrupt the other runner's active runs.
