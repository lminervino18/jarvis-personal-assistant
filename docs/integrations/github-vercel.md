# GitHub and Vercel

The accounts JARVIS uses to create repositories, push reviewed work and publish projects. Agents never see these tokens: only the server uses them, and only after the owner taps a card.

Status: connection *implemented* and *tested with fixtures*; *pending owner connection*.

## Behavior

- **GitHub** is connected with an OAuth link (Configuración › GitHub › Conectar):
  - authorization code flow with PKCE (S256) and a single-use, hashed `state` in `oauth_states` (provider `github`);
  - scope `repo`, so JARVIS can create private repositories and push to the owner's existing ones, and the callback refuses a grant without that scope;
  - the login GitHub reports is shown as the account.
- **Vercel** is connected by pasting a token created at <https://vercel.com/account/settings/tokens>, scoped to the owner's team:
  - the server checks the token with `GET /v2/user`;
  - with `PROJECTS_DOMAIN` set, the server looks up which team owns that domain, so published projects can use `<slug>.<domain>`.
- Both tokens are stored in `service_accounts`, encrypted with `TOKEN_ENCRYPTION_KEY` and bound to their provider. Disconnecting deletes the row. `integrations_status` reports both providers.

## Setup

1. GitHub › Settings › Developer settings › OAuth Apps › New OAuth App:
   - Homepage URL: `<PUBLIC_ORIGIN>`;
   - Authorization callback URL: `<PUBLIC_ORIGIN>/api/integrations/github/callback`.

   Generate a client secret.
2. Set the variables below in `/etc/jarvis/jarvis.env` and restart the server.
3. As the owner, open Configuración and tap GitHub › Conectar, then paste the Vercel token.

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
