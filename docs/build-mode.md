# Build mode (Construir)

Construir is a conversation with a Claude Code session that changes JARVIS itself. The owner writes or dictates as in a chat. The session answers questions about the project, and builds, reviews and publishes what he asks without asking him anything. By the owner's decision (2026-11-28) there are no approvals, no spending caps and no plan reserve. When the plan runs out, the session waits for the reset and goes on by itself.

Status: *implemented* and *tested with fixtures*. The first real conversation is still pending.

## Flow

```
Construir (web) ──build.request──► server: message in build_messages (work.db), never through the chat model
                                     │
agent runner (host): BuildSession reads it and resumes its Claude Code session over its own checkout
   steps (tool `pasos`) ─► progress bar · tool use ─► activity line · text ─► answers in the chat
   pnpm check ─► subagent «revisor» ─► fixes ─► tool `publicar`
                                     │ a task on project "jarvis", source "build-chat", status ready, with the patch
server: autoPublish signs it ─► publisher (host, user deploy): verify → prepare → apply → checks → commit → push → deploy
                                     │ result
BuildSession: a system note to the session ─► it explains the change to the owner in plain words, or fixes a failure and publishes again
```

## Pieces

| Piece | Code | Notes |
| --- | --- | --- |
| Screen | `apps/web/src/ui/BuildScreen.tsx` | Chat bubbles, a progress panel with the bar (finished steps out of all), the current activity, the steps and «Frenar». Refreshes every 2.5 s while open. |
| Protocol | `build.list`, `build.request`, `build.stop` → `build.chat` | `build.chat` carries the conversation and the state; nothing of Construir ever reaches the main chat. |
| Storage | `build_messages`, `build_state` (work migration 006), `apps/server/src/build-chat/build-chat-store.ts` | `system` messages are notes for the session (a publication result, a reset) and are never shown. |
| Server | `apps/server/src/build-chat/build-chat-service.ts` | Stores the owner's messages, shows the state, marks the runner offline when its heartbeat is older than 2 minutes. |
| Session | `apps/server/src/build-chat/build-session.ts`, prompt in `build-prompt.ts` | Runs in the agent runner. |
| Publisher | `apps/server/src/publisher/publisher.ts` | Unchanged flow; since 2026-11-28 it accepts changes anywhere except itself and `infra/scripts/deploy.sh`. |

## The session

- **Claude Code, full permissions.** `permissionMode: bypassPermissions`, the Claude Code preset prompt plus the Construir instructions, and the repository's own `CLAUDE.md` (`settingSources: ["project"]`). There is no Bash sandbox; the boundary is the runner's systemd unit: user `jarvis-agents`, only `/srv/jarvis/work` writable, no Docker and no secrets outside its own token.
- **One conversation.** The session id is kept in `build_state` and resumed on every message, also after a restart. A turn cut by a deploy or a crash is picked up with a note to the session.
- **Its checkout.** `/srv/jarvis/work/build/repo`, cloned from the deployed commit with dependencies installed, and kept on the commit in production before every turn. After its own publication it moves onto the new commit. When someone else published meanwhile, its unpublished work is stashed, moved onto the new commit and popped back; conflicts stay marked and the session is told which files to resolve. Without this, a patch made on an old commit failed at «apply» (2026-11-28).
- **Permissions.** Claude Code ignored `bypassPermissions` in the runner: the session started in «default» and every edit waited for an approval nobody could give (2026-11-28). A `canUseTool` that answers yes to everything grants them instead, and the Bash sandbox is off explicitly.
- **Progress.** The always-loaded MCP tool `pasos` takes the whole list of steps, each pending, in progress or done; the prompt asks the session to call it at the start and at every step. Claude Code's own to-do tool loads on demand and the session did not use it.
- **Review.** The subagent «revisor» (read-only tools plus Bash) checks the whole change and runs `pnpm check` before publishing.
- **Publishing.** The `publicar` tool takes a Conventional Commit title and a summary, writes the patch against the base commit and leaves a ready task on the `jarvis` project. The server publishes it like any reviewed task. One publication at a time; the result comes back as a note to the session. A failure goes back to the session to fix, up to three in a row; then it tells the owner and waits.
- **Explanations.** The prompt tells it to explain changes in plain words: no code, paths or commands.
- **Usage limit.** When Claude refuses, the state turns «waiting» until the reported reset (30 minutes if unknown), then the session continues on its own.
- **Stop.** «Frenar» interrupts the current turn. Messages written while it works are read when the turn ends.
- **Main chat.** Publications made by Construir add no notice to the main chat; the session reports them in Construir.

## Publisher steps

1. **verify:** signature, patch hash, and no path under `infra/`, `.github/`, `.claude/`, `Dockerfile`, `.dockerignore`, `docker-compose*.yml` or `apps/server/src/publisher/`. Those run with more privileges than the app or guard publishing itself.
2. **prepare:** refuses when `/opt/jarvis` has changes that are not on GitHub. Resets its own clone to `origin/main`.
3. **apply:** `git apply --3way`. An empty or conflicting change fails here.
4. **checks:** `docker build --target check` runs lint, typecheck, tests and build with the same toolchain as the image.
5. **commit:** authored as the owner, one line, no trailers.
6. **push:** with the deploy key, which can write to this repository only. A moved `main` fails cleanly.
7. **deploy:** `infra/scripts/deploy.sh <commit>` (backup, build, start, health). On failure it runs `deploy.sh rollback`, then pushes a `fix(build): roll back build task N after a failed deploy` revert. GitHub therefore always matches production. Database changes are not rolled back; see the runbook.

## Trust boundaries

- **The owner chose speed over gates (2026-11-28).** The Construir session has full permissions in its checkout and publishes without approvals. What it publishes runs with the app's privileges, which include the owner's personal data, and a change to the Dockerfile or compose runs with Docker's on the next deploy.
- **What still holds.** The publisher refuses unsigned requests, patches that changed after signing and any change to itself or to `infra/scripts/deploy.sh`. It runs every check and rolls back a failed deploy, and GitHub always matches production.
- **Same UID.** The server container and the agent runner both run as UID 10001, so the spool cannot tell them apart; the signature exists for that reason. The signing key lives in `jarvis.env` and `/etc/jarvis/publisher.env`, which the runner cannot read.
- **Residual risk.** Without a Bash sandbox, the session can read anything the runner's user can: `work.db` and its own token. Third-party content it reads on the web is data, never instructions, but a prompt injection there would act with these permissions. Review and tests catch mistakes, not malice.

## Setup (once, as an admin)

```bash
# signing key, shared by the server and the publisher
key=$(openssl rand -hex 32)
printf 'PUBLISH_SIGNING_KEY=%s\n' "$key" | sudo tee -a /etc/jarvis/jarvis.env >/dev/null
sudo install -m 640 -o root -g deploy infra/agents/publisher.env.example /etc/jarvis/publisher.env   # then fill it
# deploy key with write access to this repository only
sudo -u deploy ssh-keygen -t ed25519 -N '' -C jarvis-publisher -f /home/deploy/.ssh/jarvis_publish
gh api repos/OWNER/jarvis-personal-assistant/keys -f title=jarvis-publisher -f key="$(cat jarvis_publish.pub)" -F read_only=false
# GitHub host keys, checked against `gh api meta --jq .ssh_key_fingerprints`
ssh-keyscan -t ed25519 github.com | sudo tee /etc/jarvis/github_known_hosts
sudo install -m 755 infra/agents/install-host-runner.sh /usr/local/sbin/jarvis-agent-runner-install
```

The next `deploy.sh` runs the installer. It creates the spool folders, the `jarvis` project and the `jarvis-publisher.path` unit, which is enabled once `publisher.env` exists.
