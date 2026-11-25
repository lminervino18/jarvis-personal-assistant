# GitHub and Vercel

The accounts JARVIS uses to create repositories, push reviewed work and publish projects. Agents never see these tokens: only the server uses them, and only after the owner taps a card.

Status:
- connection *validated with real service*: GitHub, Vercel and both Gmail accounts connected on 2026-11-25;
- projects and publishing *implemented* and *tested with fixtures* against local repositories; the first real project is pending.

## Behavior

- **GitHub** is connected with an OAuth link (Configuración › GitHub › Conectar):
  - authorization code flow with PKCE (S256) and a single-use, hashed `state` in `oauth_states` (provider `github`);
  - scope `repo`, so JARVIS can create private repositories and push to the owner's existing ones, and the callback refuses a grant without that scope;
  - the login GitHub reports is shown as the account.
- **Vercel** is a development setting, so Configuración does not show it. It is connected once with a token created at <https://vercel.com/account/settings/tokens>, scoped to the owner's team, through `POST /api/integrations/vercel/token`:
  - the server checks the token with `GET /v2/user`;
  - with `PROJECTS_DOMAIN` set, the server looks up which team owns that domain, so published projects can use `<slug>.<domain>`.
- Both tokens are stored in `service_accounts`, encrypted with `TOKEN_ENCRYPTION_KEY` and bound to their provider. Disconnecting deletes the row. `integrations_status` reports both providers.

## Projects from the chat

- `task_create` takes `repo` (an existing repository, `owner/name` or a GitHub URL) or `newProject` (a short slug):
  - `repo`: the server checks the repository with the owner's token and clones it, or updates its clone, into `projects/gh-<owner>-<name>/repo`. It writes a `CONTEXT.md` with the base branch and the repository's conventions. The runner then copies it like any project.
  - `newProject`: the name is refused when the owner already has a repository with it. The task starts from an empty folder.
- Agents never get the GitHub or Vercel tokens. The workspace's `.git/info/exclude` keeps `node_modules`, `.env*` and build caches out of the change.
- When the task is `ready`, its card offers:
  - for a repository, **Abrir PR** (`ship_pr`) or **Subir a <base>** (`ship_main`);
  - for a new project, **Crear repo y publicar** (`ship_new`).
- The server ships in the background (`projects/project-shipper.ts`):
  1. It clones the repository fresh, or initializes the new one.
  2. It applies the exact patch the reviewer saw (`git apply --index`, `--3way` on an existing repository).
  3. It commits as the owner. The author is the GitHub login and `<id>+<login>@users.noreply.github.com`, the message is the task's Conventional Commit title, and there are no trailers.
  4. It pushes. A PR goes to `jarvis/tarea-<ref>`; `main` pushes onto the base branch and fails cleanly if it moved or is protected.
  5. A new project is created as a private repository, pushed to `main` and deployed to Vercel. Vercel detects the framework and the site is served at `<slug>.<PROJECTS_DOMAIN>`.
- Git runs without hooks or user configuration. The token goes in an HTTP header from the environment and is never written to `.git/config`.
- The card follows the publication steps and ends with the PR, commit or site link. The chat and a push notification say when it ends. A failed publication can be retried from the card.
- One project publication runs at a time; JARVIS's own publications have their own queue.

## Setup

1. GitHub › Settings › Developer settings › OAuth Apps › New OAuth App:
   - Homepage URL: `<PUBLIC_ORIGIN>`;
   - Authorization callback URL: `<PUBLIC_ORIGIN>/api/integrations/github/callback`.

   Generate a client secret.
2. Set the variables below in `/etc/jarvis/jarvis.env` and restart the server.
3. As the owner, open Configuración and tap GitHub › Conectar. Store the Vercel token once with `POST /api/integrations/vercel/token`.

| Variable | Required | Notes |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | for GitHub | OAuth app client id. |
| `GITHUB_CLIENT_SECRET` | for GitHub | OAuth app client secret. |
| `PROJECTS_DOMAIN` | no | Parent domain for published projects, for example `lminervino18.com`. Its DNS must be on Vercel in the same team. |
| `TOKEN_ENCRYPTION_KEY` | yes | Shared with Gmail. Without it neither account can be stored. |

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/connections` | owner | Accounts and whether each provider is available. |
| `GET /api/integrations/github/start` | owner | Redirects to GitHub's authorization page. |
| `GET /api/integrations/github/callback` | GitHub redirect | Its authority is the single-use `state`. Redirects to `/?integration=github&status=connected&label=<login>`, or to `status=error&reason=<denied, invalid_state or unavailable>`. |
| `POST /api/integrations/vercel/token` | owner | Body `{ "token": "…" }`. Answers `{ account, domain }`. |
| `POST /api/integrations/:provider/disconnect` | owner | `github` or `vercel`. |
