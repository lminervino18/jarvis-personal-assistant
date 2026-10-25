# Gmail

Read-only access to the owner's Gmail through the Gmail REST API, with one Google authorization per account label.

## Behavior

- Scope: `openid email https://www.googleapis.com/auth/gmail.readonly`. The server only issues `GET` requests to `users.messages.list`, `users.messages.get` (metadata) and `users.threads.get`. It never modifies labels, never marks as read, never downloads attachments.
- Labels: `personal` and `work`. Each label is bound to the real email Google reports in the ID token. Connecting a label that is bound to a different email is refused, and so is connecting an email already stored under the other label. A label whose access was revoked by the owner can be rebound.
- Current state: only `personal` is connected. `work` is fully supported but shows as `disconnected` ("Cuenta de trabajo: no conectada"), never as an error. `gmail_search` with `account: all` searches the connected accounts, labels every item with `account` and `accountEmail`, and lists the skipped ones in the coverage note.
- Results carry From, To, Subject, Date (ISO, owner's time zone), snippet, Gmail labels and, for threads, a text body truncated to about 4000 characters per message (`text/plain` preferred, HTML stripped otherwise), at most the latest 15 messages, and attachments as name, type and size only. Hidden/format characters are stripped from text.
- Everything returned is third-party content. The tools are in `untrustedContentTools`: the turn becomes tainted and any state-changing tool then needs owner confirmation (`tools/runner.ts`). The MCP wrapper prefixes results with an untrusted-content notice.

## Setup

1. Google Cloud project: enable the Gmail API.
2. OAuth consent screen: user type External for a personal Gmail account (Internal only exists inside a Workspace organization). Add the owner as a test user while the app is in Testing.
3. Create an OAuth client of type Web application. Authorized redirect URI: `<PUBLIC_ORIGIN>/api/integrations/google/callback` (or the value of `GOOGLE_REDIRECT_URI`).
4. Set the environment variables below and restart. `integrations_status` reports Gmail as `disabled` and lists what is missing until they are set.
5. As the owner (logged in), open `<PUBLIC_ORIGIN>/api/integrations/google/start?label=personal`, approve, and you are redirected to `<PUBLIC_ORIGIN>/?integration=gmail&status=connected&label=personal`. Failures redirect with `status=error&reason=<code>` (`denied`, `invalid_state`, `scope_missing`, `no_refresh_token`, `identity_rejected`, `label_bound`, `email_bound`, `unavailable`). The Gmail scope checkbox must stay ticked on the consent screen; granular consent that drops it is refused.
6. Disconnect with `POST /api/integrations/google/revoke` and body `{"label":"personal"}` (owner session; the web app sends the allowed origin). The grant is revoked at Google (best effort), the token is wiped and the status becomes `revoked`.

| Variable | Required | Notes |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | yes | OAuth web client id. |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth web client secret. |
| `GOOGLE_REDIRECT_URI` | no | Defaults to `<PUBLIC_ORIGIN>/api/integrations/google/callback`. Must match the console exactly. |
| `TOKEN_ENCRYPTION_KEY` | yes | Base64, 32 bytes. Keep it outside the database. |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | no | Old key during rotation. On start, tokens sealed with it are rewrapped with the current key. |

## Security model

- OAuth web flow with PKCE (S256), `access_type=offline`, `prompt=consent`. `state` is 32 random bytes, only its SHA-256 is stored in `oauth_states`, it is single use and expires after 10 minutes. The PKCE verifier is stored encrypted.
- The callback does not require the owner session cookie, because the session cookie is `SameSite=Strict` and is not sent on the cross-site redirect back from Google. Its authority is the one-time state that only the owner-only `start` route can create.
- Refresh tokens are encrypted with AES-256-GCM (`crypto/token-cipher.ts`, versioned format, bound to the label). Access tokens live in memory only. Tokens never appear in tool results, logs or errors.

## Failure handling

| Situation | Result |
| --- | --- |
| Refresh answers `invalid_grant` | Account `expired`, tool error `auth_expired`, an `integration` card with a "Reconectar" link to `/api/integrations/google/start?label=...`. |
| Owner revoked the grant | Account `revoked`, tool error `revoked`. |
| Label not connected | Tool error `not_connected` (non-retryable) and a "Conectar" card, only when that label was requested explicitly. |
| Gmail 401 | One refresh and retry, then `auth_expired`. |
| Gmail 429, or 403 with a rate-limit reason | `rate_limited`, retryable. |
| Gmail 5xx or network | `upstream_error`, retryable. |

`integrations_status` shows each label as `connected`, `needs_action` (expired), `disconnected` (not connected or revoked) or `error`.

## Testing vs In production

- While the consent screen is in Testing with user type External, Google issues refresh tokens that expire after 7 days (unless only name, email and profile scopes are requested). Expect `expired` weekly and a reconnect.
- Google also invalidates refresh tokens that were not used for six months, tokens of users who changed their password when the token has Gmail scopes, and the oldest token when more than 100 exist per account and client.
- For personal use the practical choice is to publish the app (publishing status In production) without going through verification: the 7-day expiry no longer applies, and the owner sees the "Google hasn't verified this app" screen once (Advanced, continue). `gmail.readonly` is a restricted scope, so verification and a security assessment would only matter for distributing the app to other people. Confirm the current limits in the console before relying on this; it has not been validated against a real account.

## Workspace (work account)

- A Workspace admin can restrict third-party app access (API controls). If the work account blocks the client, the consent screen reports an error and the admin has to allowlist the OAuth client id as trusted.
- If the Cloud project belongs to the same Workspace organization, the consent screen can be Internal: no verification and no 7-day expiry, but only for that organization's users.
- The work account must be connected from a browser signed in to that account, using `label=work`. The server refuses to bind it if the email equals the personal one.

## Official Gmail MCP server: decision

Evaluated https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server. It is a remote server (`gmailmcp.googleapis.com`) in Developer Preview that needs the `gmail.compose` scope and exposes label and draft modification tools. Decision: do not use it. It would break the read-only guarantee, put third-party content outside the in-process taint and confirmation policy, and depends on a preview program. Revisit when it is generally available with a read-only configuration.

## Validation status

Implemented and tested with fixtures (`fixtures/synthetic/gmail`, fake Google endpoints). Not validated against the real Google OAuth screen or Gmail API: pending owner connection of the personal account.
