# Security

Scope: a single-owner assistant on one VPS, used from a phone browser and later an ESP32 device. It can read mail, calendar items, WhatsApp history and web content and it holds long-lived credentials, so the design assumes content from outside is hostile and any secret may leak one day.

## Threat model

| Threat | What it could do | Main controls |
| --- | --- | --- |
| Untrusted third-party content (email, WhatsApp, web pages, video titles) with prompt injection | Trick the model into acting for the sender | Content is data. After a turn reads untrusted content, state-changing tools are held behind a confirmation card (`apps/server/src/tools/runner.ts`). The production assistant only gets the tools in `apps/server/src/tools/index.ts`: no shell, files, Docker or deployment access. Tool allowlist and hooks in `apps/server/src/runtime/tool-policy.ts`. All tools are read-only toward Gmail and WhatsApp. The bridge has no send path. Tainted voice replies can stay text-only (`VOICE_TEXT_ONLY_SOURCES`). |
| Stranger on the internet | Guess the password, reach internal services | Password hashed with scrypt (`apps/server/src/auth/password.ts`), login rate limit of 5 per 15 minutes per client IP (real IP behind Caddy through `trustProxy`), session token stored only as a SHA-256 hash with expiry (`auth/sessions.ts`), `HttpOnly`, `Secure`, `SameSite=Strict` cookie, origin check on mutating requests and on the WebSocket (`http/security.ts`), CSP and other headers from the server. Only Caddy publishes ports. |
| Stolen or lost phone | Use an open session | Sessions expire (`SESSION_TTL_DAYS`) and can be wiped from the server (runbook). Confirmation cards for state changes after untrusted content. Notifications are discreet by design (`apps/server/src/push`). |
| Leaked token or key | Read mail, call paid APIs, impersonate the owner | Secrets live only in env files outside the repository (mode 600) and in the encrypted database column values; images contain none (`.dockerignore`, gitleaks in CI). Rotation and revocation table below. |
| Compromised container | Pivot to the host or other services | Non-root UID 10001, read-only root filesystem, all capabilities dropped, `no-new-privileges`, resource and PID limits, voice sidecars on a network without internet, no Docker socket mounted anywhere. |
| Stolen backup | Read history | restic encrypts and authenticates everything with `RESTIC_PASSWORD`; the bucket key is limited to one bucket. The `TOKEN_ENCRYPTION_KEY` is not in the backup, so stored provider tokens stay sealed. Message text is in the backup, so the restic password is as sensitive as the database. |
| Supply chain | Malicious dependency, image or action | Exact versions and a frozen lockfile in CI; base images, Caddy, restic, gitleaks and actionlint pinned by digest; GitHub Actions pinned by commit SHA; Dependabot for npm, actions and Dockerfiles (WhatsApp library excluded on purpose: upgrade it by hand). |
| Loss of the server | Lose data | Daily encrypted off-site backups, retention `BACKUP_RETENTION_DAYS`, restore drilled in CI and monthly (`docs/runbook.md`). |
| Provider account action (WhatsApp ban) | Restriction of the owner's number | Accepted by the owner, mitigations and residual risk in `docs/integrations/whatsapp.md`. |

Out of scope: a malicious or compromised hosting provider with access to the VM memory, and a compromised owner computer (it holds the Claude login and the password manager).

## Controls in code

| Control | File |
| --- | --- |
| Environment given to the Claude subprocess is an allowlist; API keys and the encryption key never reach it | `apps/server/src/runtime/runtime-env.ts` (tested in `runtime.test.ts`) |
| Tool policy, schema validation, idempotency, confirmation after untrusted content | `apps/server/src/tools/runner.ts`, `apps/server/src/runtime/tool-policy.ts` |
| Provider tokens and the WhatsApp session encrypted with AES-256-GCM, key rotation | `apps/server/src/crypto/token-cipher.ts` |
| Security headers, CSP, allowed origins | `apps/server/src/http/security.ts`, `apps/server/src/app.ts` |
| Logger redaction of cookies, authorization, tokens and bodies | `apps/server/src/logger.ts` |
| Reminders worker starts without the owner password or Claude credentials | `apps/server/src/worker/config.ts` |

## Infrastructure controls

| Control | Where |
| --- | --- |
| Only 80 and 443 (and SSH) reachable; SSH keys only, root login off; unattended upgrades; optional fail2ban | host setup in `docs/deploy.md` |
| HTTP redirected to HTTPS, automatic certificates, HTTP/3, compression off on `/ws`, timeouts, `Server` header removed | `infra/caddy/Caddyfile` |
| Caddy access log without query strings, cookies, authorization or `Set-Cookie` | `infra/caddy/Caddyfile` |
| Container hardening, limits, log rotation, restart policy, private voice network | `docker-compose.yml` |
| Multi-stage image, no secrets in layers, non-root user, healthcheck, init process | `Dockerfile`, `.dockerignore` |
| Encrypted backups, integrity check before upload, tested restore | `infra/backup/`, `infra/scripts/restore-test.sh` |
| CI: frozen install, lint, typecheck, tests, build, image build, restore test, gitleaks over the full history, actionlint, shellcheck | `.github/workflows/ci.yml` |

Caddy is the one container that runs as root inside its namespace (with every capability dropped except `NET_BIND_SERVICE`, read-only root and `no-new-privileges`), because binding ports 80 and 443 without root needs extra volume ownership work. Revisit if Caddy gets a non-root image.

## Secrets inventory and rotation

| Secret | Where it lives | If it leaks |
| --- | --- | --- |
| `OWNER_PASSWORD_HASH` (and the password) | `/etc/jarvis/jarvis.env`, password manager | Change the password, wipe sessions. |
| `CLAUDE_CODE_OAUTH_TOKEN` | `jarvis.env` | Revoke the token from the Claude account, run `claude setup-token`, replace. Someone with the token can spend the owner's plan. |
| `TOKEN_ENCRYPTION_KEY` (+ `_PREVIOUS`) | `jarvis.env`, password manager | Rotate with `_PREVIOUS`; if the database was also taken, also revoke Google grants and unlink WhatsApp. |
| Google client secret, Gmail refresh tokens | client secret in `jarvis.env`; tokens encrypted in the database | Revoke the grant at `myaccount.google.com/permissions`, rotate the client secret. |
| WhatsApp session | encrypted in the database (`wa_auth_state`) | Unlink the device on the phone, wipe the session. |
| `VAPID_PRIVATE_KEY` | `jarvis.env` | Regenerate, resubscribe the browser. |
| `YOUTUBE_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` | `jarvis.env` | Delete the key at the vendor, create another. Check the vendor usage page for abuse. |
| `RESTIC_PASSWORD`, bucket key | `backup.env`, password manager | Rotate both; a leaked bucket key without the password only allows deleting or overwriting backups, so also check the repository with `restic check`. |
| SSH keys | owner machines | Remove from `authorized_keys`. |

If a secret leaks (pasted in chat, committed, shown in a screenshot): revoke or rotate it at its issuer first, then clean up. Removing it from the last commit or deleting the file does not help: it remains in Git history, forks, caches and CI logs. Treat it as public until revoked. After revoking, remove it from history only if useful, and never rewrite shared history to hide the incident without recording it. CI's gitleaks job scans the whole history on every push to catch it early.

## Token and session revocation

- Web session: logout (`POST /api/auth/logout`) or the sessions wipe in `docs/runbook.md`.
- Gmail: `POST /api/integrations/google/revoke` (owner session) revokes at Google and wipes the stored token; or revoke from the Google account page.
- WhatsApp: unlink the device on the phone; the bridge stops on logout and wipes the stored session.
- Claude: revoke the token in the Claude account, then issue a new one.
- Push: unsubscribe in the browser or rotate the VAPID keys.

## Log policy

- Application logs (JSON, pino) never contain message bodies, tokens, cookies or audio; redaction is configured in `logger.ts`. Do not raise `LOG_LEVEL` to `debug` on the server for long.
- Caddy logs request metadata only (no query strings or cookies).
- Docker rotates logs at 10 MB x 5 per container, so history is days, not months. Nothing ships logs elsewhere.
- Backups hold content, logs do not.

## Known gaps and decisions for the owner

- The worker and the WhatsApp bridge have no Docker healthcheck. The restart policy covers crashes but not a hang. The worker would need to touch a heartbeat file each cycle (requested change in the delivery report).
- Fastify's default request log includes the URL with its query string. No secret travels in a query string by design, but the Google OAuth callback carries a one-time `code` and `state`. A serializer that drops the query is a one-line change in `apps/server/src/app.ts` (requested change in the delivery report).
- No WAF or CDN in front. The login rate limit and the HTTPS-only cookie are the main defense; add Cloudflare in front only if abuse appears.
- Backups are only as private as `RESTIC_PASSWORD`; and the deleted-memory promise is bounded by `BACKUP_RETENTION_DAYS`: a memory forgotten today stays in older snapshots until they expire.
- The Claude subscription token is a bearer credential valid for about a year.
