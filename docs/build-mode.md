# Build mode

Build mode lets the owner change JARVIS itself from the app. It reuses the delegated-task pipeline ([agents.md](agents.md)) on a project called `jarvis`. A deterministic publisher, with no model involved, ships a change as soon as the independent reviewer approves it. The owner decided on 2026-11-25 not to approve each one, and gets a notification when it is published or when it fails.

Status: *implemented* and *tested with fixtures*. The first real publication is still pending.

## Flow

```
Construir (web) ──build.request──► server: task on project "jarvis" (no model, no chat tokens)
                                     │
agent runner (host): plan → execute → review, in a copy of the deployed commit with dependencies installed
                                     │ ready: card with summary, review score and "ver cambios"
reviewer approves ──TaskService.autoPublish──► server: signed request + exact patch in /srv/jarvis-publish/requests
                                     │ systemd path unit
publisher (host, user deploy): verify → prepare → apply → checks → commit → push → deploy
                                     │ result file
server: card status and one chat message plus push when it ends
```

## Pieces

| Piece | Code | Notes |
| --- | --- | --- |
| Build screen | `apps/web/src/ui/BuildScreen.tsx` | Topbar hammer button. Lists build tasks, refreshes every 4 s while open. A new request, an answer or a change request is sent from the bottom field. |
| Protocol | `build.list`, `build.request`, `build.feedback`, `build.tasks`; task action `publish` | Requests go straight to `TaskService`, never through the chat model. |
| Server | `TaskService.createBuild`, `buildFeedback`, `buildCards`, `publish`, `syncPublications` | One publication at a time (`task_publications` in `work.db`). A message about a published task starts a new task instead of reopening it. |
| Spool | `apps/server/src/publisher/spool.ts` | Requests are HMAC-signed with `PUBLISH_SIGNING_KEY`. The patch is written first and the request last, by rename. |
| Publisher | `apps/server/src/publisher/publisher.ts`, entry `publisher-main.ts` | Runs as `deploy` from `/opt/jarvis-agents`, the root-owned copy of the deployed build. |
| Project | `infra/agents/projects/jarvis/` | The installer copies `CONTEXT.md` and `setup.sh` and clones the deployed commit into `/srv/jarvis/work/projects/jarvis/repo` on every deploy. |

## Agent workspace

- The runner clones the project repository and then runs the project's `setup.sh` (`pnpm install --frozen-lockfile`) itself, before any agent touches the copy. Install scripts therefore only come from the deployed commit.
- The reviewer's disposable clone gets the same `node_modules` as hard links (`cp -al`), so it can run the tests too.
- Agents can reach package registries, but `CONTEXT.md` tells them not to add dependencies unless the request asks. The publisher installs from the lockfile, so a new dependency must come with its lockfile change.
- The executor reports `commitTitle`, a Conventional Commit title in English. The server checks it and falls back to `feat(build): apply build task N`.

## Publisher steps

1. **verify:** signature, patch hash, and no path under `infra/`, `.github/`, `.claude/`, `Dockerfile`, `.dockerignore`, `docker-compose*.yml` or `apps/server/src/publisher/`. Those run with more privileges than the app or guard publishing itself.
2. **prepare:** refuses when `/opt/jarvis` has changes that are not on GitHub. Resets its own clone to `origin/main`.
3. **apply:** `git apply --3way`. An empty or conflicting change fails here.
4. **checks:** `docker build --target check` runs lint, typecheck, tests and build with the same toolchain as the image.
5. **commit:** authored as the owner, one line, no trailers.
6. **push:** with the deploy key, which can write to this repository only. A moved `main` fails cleanly.
7. **deploy:** `infra/scripts/deploy.sh <commit>` (backup, build, start, health). On failure it runs `deploy.sh rollback`, then pushes a `fix(build): roll back build task N after a failed deploy` revert. GitHub therefore always matches production. Database changes are not rolled back; see the runbook.

## Trust boundaries

- **The independent review is the gate.** The server signs a request only for a task the reviewer approved (status `ready`), or when the owner retries a failed publication. The publisher refuses unsigned requests and patches that changed after signing. It still runs every check and rolls back a failed deploy.
- **Same UID.** The server container and the agent runner both run as UID 10001. The spool folder therefore cannot tell them apart, and the signature exists for that reason.
- **Signing key.** It lives in `jarvis.env` and `/etc/jarvis/publisher.env`, where agents cannot read it.
- **Residual risk.** An agent that escaped the bubblewrap sandbox could read the server process environment under the same UID. Since 2026-11-25 agents have network by the owner's decision, which widens this risk. Setting `AGENT_ALLOWED_DOMAINS` empty narrows it again.
- **App code.** A published change runs with the app's own privileges, which include the owner's personal data. Reading the diff before publishing is the owner's control. Tests and review catch mistakes, not malice.

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
