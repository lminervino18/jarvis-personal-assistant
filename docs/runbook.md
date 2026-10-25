# Runbook

All commands run on the server in `/opt/jarvis` as the deploy user. First deploy and host preparation are in `docs/deploy.md`.

## Daily facts

- Logs: `docker compose logs -f --tail=100 server worker` (also `caddy`, `backup`, `whatsapp-bridge`). Docker keeps 5 files of 10 MB per container.
- Status: `docker compose ps`. `server`, `backup`, `piper` and `whisper` have healthchecks; the worker and the bridge do not (see "Known gaps" in `docs/security.md`). Check the worker with its log line `reminders claimed` after a reminder, or ask the assistant for the integrations status.
- The backup sidecar runs daily at `BACKUP_TIME`, and once when it starts if no successful run is recorded. It is healthy while the last success is under 36 hours old. With `BACKUP_PING_URL` set, a failed or missing run alerts you by the monitor.

## Connect accounts

| Account | Steps |
| --- | --- |
| Web login | Browse to the domain and sign in with the owner password. Sessions last `SESSION_TTL_DAYS`. |
| Push notifications | Sign in on the phone, allow notifications when the app asks. Requires the `VAPID_*` keys. Without them reminders reach the chat only. |
| Claude | `claude setup-token` on your computer, set `CLAUDE_CODE_OAUTH_TOKEN` in `/etc/jarvis/jarvis.env`, then `docker compose up -d server`. |
| Gmail | Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY`, restart the server, then open `https://<domain>/api/integrations/google/start?label=personal` while signed in. Details and the Testing-mode seven-day expiry in `docs/integrations/gmail.md`. |
| WhatsApp (experimental) | Add `WHATSAPP_ENABLED=true` and `TOKEN_ENCRYPTION_KEY`, enable the profile, `docker compose up -d whatsapp-bridge`, and scan the pairing card from WhatsApp, Linked devices. One container only. Read `docs/integrations/whatsapp.md` for the ban risk first. |
| YouTube | Set `YOUTUBE_API_KEY`, restart the server. |

Changing `jarvis.env` needs `docker compose up -d <service>`; `restart` does not reread the file.

## Rotate secrets

| Secret | How | Effect |
| --- | --- | --- |
| Owner password | Generate a new hash locally, replace `OWNER_PASSWORD_HASH`, `docker compose up -d server`. To end every existing session, also run the sessions wipe below. | Old password stops working. |
| `CLAUDE_CODE_OAUTH_TOKEN` | See "Renew the Claude token". | Turns fail with an auth error until replaced. |
| `TOKEN_ENCRYPTION_KEY` | Generate a new key, move the old value to `TOKEN_ENCRYPTION_KEY_PREVIOUS`, put the new one in `TOKEN_ENCRYPTION_KEY`, restart the server and bridge. Stored tokens are rewrapped; the bridge rewraps on start. Drop `_PREVIOUS` after a backup cycle. | No reconnects needed. |
| `VAPID_*` | `vapid:generate` locally, replace, restart server and worker. Browsers must resubscribe (open the app and allow notifications again). | Old subscriptions stop receiving pushes. |
| Google client secret | Create a new secret in Google Cloud Console, replace `GOOGLE_CLIENT_SECRET`, restart the server, delete the old secret in the console. | Existing grants keep working. |
| `YOUTUBE_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` | Create the new key at the vendor, replace it, restart the server, delete the old key at the vendor. | |
| Backup keys | Create a new bucket key, replace `AWS_*` in `backup.env`, `docker compose up -d backup`, run a backup, delete the old key. | |
| `RESTIC_PASSWORD` | Add a new key with `docker compose exec backup restic key add`, switch the env value, remove the old key with `restic key remove`. | |

Wipe all web sessions (after a stolen phone, for example):

```bash
docker compose exec worker node -e 'const D=require("better-sqlite3");const db=new D("/data/jarvis.db");console.log(db.prepare("DELETE FROM auth_sessions").run().changes);db.close()'
```

## Renew the Claude token

`claude setup-token` prints an OAuth token valid for about a year. Put a yearly reminder in your calendar. To renew: run it on your computer, replace `CLAUDE_CODE_OAUTH_TOKEN`, `docker compose up -d server`, and ask the assistant something simple. If the account ever shows as logged out, revoke the old token from your Claude account settings. If Anthropic changes the plan rules, `docs/claude-runtime.md` is where the route was checked.

## Restore

When: the database is corrupted, a bad deploy migrated it, data was deleted by mistake, or the server was lost.

1. Have the restic password and the bucket keys ready (password manager). On a new server, do `docs/deploy.md` sections 2 to 4 first, with the same `backup.env`.
2. Stop writers:

```bash
docker compose stop server worker whatsapp-bridge backup
```

3. Look at what exists: `docker compose run --rm --no-deps backup restic snapshots`.
4. Restore (latest, or a snapshot id) into `/data`:

```bash
docker compose run --rm --no-deps backup restore.sh latest /data
```

It restores into a scratch directory first, runs `PRAGMA integrity_check`, and only then moves the current `jarvis.db`, `-wal`, `-shm` and `memory/` aside as `*.pre-restore-<timestamp>` and puts the restored copy in place. It prints a row count per table.
5. Start and check: `docker compose up -d --wait`, `curl -fsS https://<domain>/healthz`, sign in, ask for the integrations status.
6. Reconnect what the restore cannot carry: Claude uses the env token (nothing to do); Gmail and WhatsApp tokens are in the database, encrypted, and work only with the same `TOKEN_ENCRYPTION_KEY` (reconnect if you lost it); push subscriptions are in the database.
7. When satisfied, delete the `*.pre-restore-*` files in the data volume.

What the backup contains: a consistent snapshot of `jarvis.db` and the `memory/` directory (the private `loren.md`). It does not contain `/data/claude`, `.env` files or the Caddy certificates (Caddy obtains new ones).

Drills, monthly: `infra/scripts/restore-test.sh` on a development machine (synthetic data, local repository), and a real dry run that touches nothing:

```bash
docker compose run --rm --no-deps backup sh -c 'restore.sh latest /cache/restore-check && rm -rf /cache/restore-check'
```

## Roll back a deploy

Image only (the new code is broken but the database is fine):

```bash
infra/scripts/deploy.sh rollback
```

Migration involved (the new version changed the schema and the old one cannot open it): roll back the image as above, stop `server worker`, then restore the pre-deploy snapshot with the "Restore" steps. The snapshot taken by `deploy.sh` just before the deploy is the newest one at that moment; anything written after it is lost, so pick it by time with `restic snapshots`. Migrations never run backwards.

## Incident checklist

1. Contain: if you suspect a leaked secret or a stolen device, sign everyone out (sessions wipe above) and stop the stack: `docker compose stop`. The data stays in the volume.
2. Identify what leaked using the table in `docs/security.md` and rotate it. Deleting the secret from the last commit is not enough: revoke it at its issuer first, then rotate (details in `docs/security.md`).
3. Review: `docker compose logs --since 24h server caddy`. Caddy access logs contain method, path, status, IP and user agent, no query strings, cookies or bodies. Look for unexpected paths, many 401 responses on `/api/auth/login`, or origins you do not recognize.
4. Disconnect integrations you doubt: Gmail via `POST /api/integrations/google/revoke` or `myaccount.google.com/permissions`; WhatsApp by unlinking the device on the phone.
5. Restore from a snapshot taken before the incident if data was altered.
6. Write down what happened and what changed.

## Common problems

| Symptom | Check |
| --- | --- |
| Caddy cannot get a certificate | DNS points at the server, ports 80 and 443 reachable, `docker compose logs caddy`. Let's Encrypt rate limits apply to repeated failures. |
| `server` unhealthy at start | `docker compose logs server`; in production `OWNER_PASSWORD_HASH` is required, `PUBLIC_ORIGIN` must be a valid URL. |
| Turns fail right away | Token expired or revoked: renew it. Plan limit reached: the runtime reports it; wait or raise the plan. |
| No reminders push | `VAPID_*` set on both server and worker? Browser resubscribed? Reminders still reach the chat. |
| Backup unhealthy | `docker compose logs backup`: bad bucket key, wrong `RESTIC_PASSWORD` for an existing repository, or the bucket is unreachable. |
| Disk filling | `docker system df`; `docker image prune` removes old tags (keep the previous one for rollback). |
