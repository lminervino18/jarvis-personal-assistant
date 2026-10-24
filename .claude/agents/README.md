# Development subagents

These role definitions are for the agents that build J.A.R.V.IS. They are not part of the running assistant, which uses one simple coordinator and deterministic tools.

| Role | File | Owns |
| - | - | - |
| A. Runtime and memory (integration lead) | `runtime-memory.md` | `packages/contracts`, `apps/server/src/{runtime,conversation,memory,tools/runner.ts,db}`, integration of all branches |
| B1. Agenda, reminders, notifications | `integrations-core.md` | `apps/server/src/{agenda,worker,push}`, agenda tools, `src/worker.ts` |
| B2. External connectors | `integrations-connectors.md` | `apps/server/src/integrations`, `apps/server/src/crypto`, Gmail/WhatsApp/YouTube tools |
| C. Voice and personality | `voice.md` | `apps/server/src/voice`, `voice/`, personality sections of `assistant/CLAUDE.md` |
| D. Web and motion | `web.md` | `apps/web` |
| E. Infrastructure and security | `infra-security.md` | `infra/`, Dockerfiles, compose, `.github/`, deployment docs, `SECURITY.md` |
| F. Integration QA | `qa.md` | `tests/e2e`, verification reports |
| G. Device | `device.md` | `firmware/`, `tools/device-sim`, `apps/server/src/devices` |

Shared rules for every role are in `_shared.md`.
