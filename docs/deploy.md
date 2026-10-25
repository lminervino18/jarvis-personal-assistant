# Deploy

One small Linux VPS runs everything with Docker Compose: the server (API, WebSocket, web app), the reminders worker, Caddy (HTTPS), a backup sidecar, and optionally the WhatsApp bridge and the local voice sidecars. Nothing is deployed from this repository by automation: the owner approves the spending and runs these steps. What a first month costs is in `docs/costs.md`.

## What runs

| Service | Image | Published ports | Profile |
| --- | --- | --- | --- |
| `server` | `jarvis:<tag>` (this repo's `Dockerfile`) | none (Caddy reaches it on 8080) | always |
| `worker` | same image, `node dist/worker.js` | none | always |
| `caddy` | `caddy:2.11.7-alpine` (pinned by digest) | 80, 443 tcp, 443 udp | always |
| `backup` | `jarvis-backup:<tag>` (`infra/backup`) | none | always |
| `whatsapp-bridge` | same image, `node dist/whatsapp-bridge.js` | none | `whatsapp` |
| `whisper`, `piper` | `infra/voice/*` | none, private network without internet | `voice` |

All containers: `restart: unless-stopped`, read-only root filesystem, all capabilities dropped (Caddy keeps only `NET_BIND_SERVICE`), `no-new-privileges`, CPU, memory and PID limits, JSON logs rotated at 10 MB x 5 files. The application image runs as UID 10001. The data lives in the `jarvis-data` volume (`/data`: `jarvis.db`, `memory/loren.md`, `claude/`).

## 1. Decisions and accounts (owner)

1. A server: see `docs/costs.md`. Any Debian 13 or Ubuntu 24.04 LTS machine with 2 vCPU and 2 GB or more works; 4 GB leaves room. Use a region near Buenos Aires if latency matters.
2. A domain. Point an `A` record (and `AAAA` if the server has IPv6) at the server. Caddy obtains and renews the certificate by itself; ports 80 and 443 must reach it.
3. An S3-compatible bucket for backups (Backblaze B2 or Cloudflare R2) with an application key limited to that bucket.
4. Optional: Google OAuth client (Gmail), YouTube API key, Groq and ElevenLabs keys. See `.env.example` and `docs/integrations/`.

## 2. Prepare the host

Run as root once, then work as the deploy user.

```bash
adduser --disabled-password deploy && usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/ && chown -R deploy: /home/deploy/.ssh

sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl reload ssh

apt-get update && apt-get install -y ufw unattended-upgrades
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw enable
dpkg-reconfigure -plow unattended-upgrades
```

Install Docker Engine and the Compose plugin from Docker's official apt repository (https://docs.docker.com/engine/install/), add `deploy` to the `docker` group, and install `git`. Optional: `fail2ban` for SSH.

Docker publishes container ports by editing iptables itself, bypassing `ufw` rules. That is acceptable here because only Caddy publishes ports (80 and 443); the voice and bridge services publish nothing. Do not add `ports:` to other services.

## 3. Code and secrets

```bash
sudo mkdir -p /opt/jarvis /etc/jarvis && sudo chown deploy: /opt/jarvis
git clone <repository url> /opt/jarvis && cd /opt/jarvis
sudo install -m 600 -o deploy /dev/null /etc/jarvis/jarvis.env
sudo install -m 600 -o deploy /dev/null /etc/jarvis/backup.env
install -m 600 /dev/null /opt/jarvis/.env
```

`.env.example` documents every variable and which file it belongs to. Edit the three files by hand; never commit them.

`/opt/jarvis/.env` (read by Compose for interpolation only):

```
JARVIS_DOMAIN=jarvis.example.com
ACME_EMAIL=owner@example.com
BACKUP_RETENTION_DAYS=30
```

`/etc/jarvis/jarvis.env` (server, worker, bridge). Generate the values on your own computer, not on the server:

```
PUBLIC_ORIGIN=https://jarvis.example.com
OWNER_PASSWORD_HASH='<output of: pnpm --filter @jarvis/server hash-password>'
CLAUDE_CODE_OAUTH_TOKEN=<output of: claude setup-token>
TOKEN_ENCRYPTION_KEY=<output of: openssl rand -base64 32>
VAPID_PUBLIC_KEY=...        # pnpm --filter @jarvis/server vapid:generate
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:owner@example.com
```

Rules that matter:

- Claude on the server uses the owner's subscription: run `claude setup-token` on your own machine (browser sign-in) and paste the printed token as `CLAUDE_CODE_OAUTH_TOKEN`. Do not use `--bare` (it ignores that variable), do not copy credential files or cookies, and never set `ANTHROPIC_API_KEY` (the runtime also strips it). `CLAUDE_CONFIG_DIR=/data/claude` is set by the image.
- Wrap `OWNER_PASSWORD_HASH` in single quotes: it contains `$`.
- Keep a copy of `TOKEN_ENCRYPTION_KEY` and of the restic password in your password manager, outside the server and outside the backups. Without the key the stored Google and WhatsApp credentials are unreadable after a restore (you reconnect the accounts); without the restic password the backups cannot be opened at all.
- Delete variables you do not set instead of leaving them empty: an empty `PORT=` is read as an empty string.
- `VAPID_*` are all or none; the subject is `mailto:` or `https://`.

`/etc/jarvis/backup.env` (backup sidecar only):

```
RESTIC_REPOSITORY=s3:https://s3.us-west-004.backblazeb2.com/<bucket>/jarvis
RESTIC_PASSWORD=<long random string>
AWS_ACCESS_KEY_ID=<application key id>
AWS_SECRET_ACCESS_KEY=<application key>
AWS_DEFAULT_REGION=us-west-004
BACKUP_TIME=03:30
# BACKUP_PING_URL=https://hc-ping.com/<uuid>   optional dead-man's switch
```

For Cloudflare R2 use `RESTIC_REPOSITORY=s3:https://<account id>.r2.cloudflarestorage.com/<bucket>/jarvis` and `AWS_DEFAULT_REGION=auto`. The first backup initializes the repository. `BACKUP_TIME` is local time (America/Argentina/Buenos_Aires).

## 4. First deploy

```bash
cd /opt/jarvis
infra/scripts/deploy.sh "$(git rev-parse --short HEAD)"
```

The script builds the images (`jarvis:<tag>`, `jarvis-backup:<tag>` and those of the enabled profiles), records the tag and the previous one in `/opt/jarvis/.env`, and runs `docker compose up -d --wait`. When a previous deployment exists it first runs a backup (`backup.sh`) and refuses to continue if that fails. Optional profiles:

```bash
echo 'COMPOSE_PROFILES=voice' >> .env        # local Piper and faster-whisper (needs 4 vCPU / 8 GB)
echo 'COMPOSE_PROFILES=whatsapp' >> .env    # comma-separate to enable both
```

Local voice also needs `STT_PROVIDER=faster-whisper`, `FASTER_WHISPER_URL=http://whisper:8000/v1`, `TTS_PROVIDER=piper`, `PIPER_URL=http://piper:5000` in `jarvis.env`. The WhatsApp bridge is a single container sharing `/data` with the server and holds a lock file there; never scale it. It stays idle unless `WHATSAPP_ENABLED=true`.

## 5. Check it works

```bash
docker compose ps                                        # server and backup "healthy", others "Up"
curl -fsS https://jarvis.example.com/healthz             # {"ok":true}
docker compose logs --tail=20 worker                     # "worker started"
docker compose exec backup restic snapshots              # one snapshot after the first backup
```

Then open `https://<domain>` in the phone browser, sign in, and install the PWA. Connecting accounts and the rest of the routine tasks are in `docs/runbook.md`.

## 6. Updates and rollback

```bash
cd /opt/jarvis && git pull --ff-only
infra/scripts/deploy.sh "$(git rev-parse --short HEAD)"      # snapshot, build, start
infra/scripts/deploy.sh rollback                             # previous tag
```

Database migrations only move forward. Rolling back the image does not undo a migration; if the new version migrated the database and the old one cannot read it, restore the pre-deploy snapshot as described in `docs/runbook.md`.

## 7. Verifying the toolchain without a server

Everything above except the server itself is tested on a developer machine and in CI:

```bash
docker build -t jarvis:local .
infra/scripts/restore-test.sh      # synthetic database, local restic repository
```

`restore-test.sh` seeds a synthetic database while the server runs, backs it up twice, wipes the volume, restores, compares row counts of every table, and boots the server on the restored database.
