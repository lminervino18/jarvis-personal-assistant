#!/usr/bin/env bash
# Usage: install-host-runner.sh <tag>
# Runs the agent runner as a systemd service on the host, from the jarvis-agent-runner:<tag> image,
# refreshes the jarvis project agents build on, and installs the build publisher.
# Install once with: sudo install -m 755 infra/agents/install-host-runner.sh /usr/local/sbin/jarvis-agent-runner-install
set -euo pipefail

tag=${1:-}
[[ "$tag" =~ ^[0-9a-zA-Z._-]{1,64}$ ]] || { echo "usage: $0 <tag>" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

work=/srv/jarvis/work
dir=/opt/jarvis-agents
image="jarvis-agent-runner:$tag"
source_dir=${JARVIS_DIR:-/opt/jarvis}
publish=/srv/jarvis-publish

getent group jarvis-agents >/dev/null || groupadd --gid 10001 jarvis-agents
id jarvis-agents >/dev/null 2>&1 || useradd --uid 10001 --gid 10001 --home-dir /var/lib/jarvis-agents --no-create-home --shell /usr/sbin/nologin jarvis-agents
install -d -m 750 -o 10001 -g 10001 /srv/jarvis "$work"

if [ ! -e "$work/.migrated" ] && docker volume inspect jarvis_work-data >/dev/null 2>&1; then
  docker run --rm --user 10001:10001 -v jarvis_work-data:/from:ro -v "$work":/to --entrypoint sh "$image" -c 'cp -a /from/. /to/'
  install -m 640 -o 10001 -g 10001 /dev/null "$work/.migrated"
fi
chmod 750 "$work"

rm -rf "$dir.new"
install -d -m 755 "$dir.new/bin"
container=$(docker create "$image")
docker cp "$container:/app" "$dir.new/app"
docker cp "$container:/usr/local/bin/node" "$dir.new/bin/node"
install -d -m 755 "$dir.new/lib"
docker cp "$container:/usr/local/lib/node_modules/pnpm" "$dir.new/lib/pnpm"
docker rm "$container" >/dev/null
printf '#!/bin/sh\nexec /opt/jarvis-agents/bin/node /opt/jarvis-agents/lib/pnpm/bin/pnpm.cjs "$@"\n' > "$dir.new/bin/pnpm"
chmod 755 "$dir.new/bin/pnpm"
chown -R root:root "$dir.new"
chmod -R go-w "$dir.new"
rm -rf "$dir.old"
if [ -d "$dir" ]; then mv "$dir" "$dir.old"; fi
mv "$dir.new" "$dir"

cat > /etc/systemd/system/jarvis-agent-runner.service <<'UNIT'
[Unit]
Description=J.A.R.V.IS agent runner (delegated tasks)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=jarvis-agents
Group=jarvis-agents
WorkingDirectory=/opt/jarvis-agents/app
EnvironmentFile=/etc/jarvis/agents.env
Environment=NODE_ENV=production
Environment=WORK_DIR=/srv/jarvis/work
Environment=HOME=/var/lib/jarvis-agents
Environment=AGENT_HEARTBEAT_FILE=/run/jarvis-agents/heartbeat
Environment=PATH=/opt/jarvis-agents/bin:/usr/bin:/bin
ExecStart=/opt/jarvis-agents/bin/node dist/agent-runner.js
Restart=on-failure
RestartSec=15
RuntimeDirectory=jarvis-agents
StateDirectory=jarvis-agents
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/srv/jarvis/work
TemporaryFileSystem=/run/containerd:ro
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
LockPersonality=yes
MemoryMax=2500M
CPUQuota=150%
CPUWeight=20
IOWeight=20
Nice=10
TasksMax=1024

[Install]
WantedBy=multi-user.target
UNIT

project=$work/projects/jarvis
install -d -m 750 -o 10001 -g 10001 "$work/projects" "$project"
install -m 644 -o 10001 -g 10001 "$source_dir/infra/agents/projects/jarvis/CONTEXT.md" "$project/CONTEXT.md"
install -m 755 -o 10001 -g 10001 "$source_dir/infra/agents/projects/jarvis/setup.sh" "$project/setup.sh"
rm -rf "$project/repo.new" "$project/repo.old"
git -c safe.directory='*' clone --quiet --no-hardlinks "$source_dir" "$project/repo.new"
chown -R 10001:10001 "$project/repo.new"
if [ -d "$project/repo" ]; then mv "$project/repo" "$project/repo.old"; fi
mv "$project/repo.new" "$project/repo"
rm -rf "$project/repo.old"

install -d -m 755 -o root -g root "$publish"
install -d -m 2770 -o 10001 -g deploy "$publish/requests"
install -d -m 2750 -o deploy -g 10001 "$publish/results"
install -d -m 700 -o deploy -g deploy "$publish/done" "$publish/repo"

cat > /etc/systemd/system/jarvis-publisher.service <<'UNIT'
[Unit]
Description=J.A.R.V.IS build publisher (owner-approved changes)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
User=deploy
Group=deploy
WorkingDirectory=/srv/jarvis-publish
EnvironmentFile=/etc/jarvis/publisher.env
Environment=HOME=/home/deploy
Environment=PATH=/opt/jarvis-agents/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/opt/jarvis-agents/bin/node /opt/jarvis-agents/app/dist/publisher-main.js
TimeoutStartSec=2h
CPUWeight=20
IOWeight=20
Nice=10
UNIT

cat > /etc/systemd/system/jarvis-publisher.path <<'UNIT'
[Unit]
Description=Watch for owner-approved J.A.R.V.IS build publications

[Path]
PathExistsGlob=/srv/jarvis-publish/requests/*.json
Unit=jarvis-publisher.service

[Install]
WantedBy=paths.target
UNIT

systemctl daemon-reload
systemctl enable jarvis-agent-runner >/dev/null
systemctl restart jarvis-agent-runner
if [ -f /etc/jarvis/publisher.env ]; then systemctl enable --now jarvis-publisher.path >/dev/null 2>&1; fi
echo "agent runner $tag installed"
