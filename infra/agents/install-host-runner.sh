#!/usr/bin/env bash
# Usage: install-host-runner.sh <tag>
# Runs the agent runner as a systemd service on the host, from the jarvis-agent-runner:<tag> image.
# Install once with: sudo install -m 755 infra/agents/install-host-runner.sh /usr/local/sbin/jarvis-agent-runner-install
set -euo pipefail

tag=${1:-}
[[ "$tag" =~ ^[0-9a-zA-Z._-]{1,64}$ ]] || { echo "usage: $0 <tag>" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

work=/srv/jarvis/work
dir=/opt/jarvis-agents
image="jarvis-agent-runner:$tag"

getent group jarvis-agents >/dev/null || groupadd --gid 10001 jarvis-agents
id jarvis-agents >/dev/null 2>&1 || useradd --uid 10001 --gid 10001 --home-dir /var/lib/jarvis-agents --no-create-home --shell /usr/sbin/nologin jarvis-agents
install -d -m 750 -o 10001 -g 10001 /srv/jarvis "$work"

if [ ! -e "$work/.migrated" ] && docker volume inspect jarvis_work-data >/dev/null 2>&1; then
  docker run --rm --user 10001:10001 -v jarvis_work-data:/from:ro -v "$work":/to --entrypoint sh "$image" -c 'cp -a /from/. /to/'
  install -m 640 -o 10001 -g 10001 /dev/null "$work/.migrated"
fi

rm -rf "$dir.new"
install -d -m 755 "$dir.new/bin"
container=$(docker create "$image")
docker cp "$container:/app" "$dir.new/app"
docker cp "$container:/usr/local/bin/node" "$dir.new/bin/node"
docker rm "$container" >/dev/null
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
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryMax=2500M
CPUQuota=150%
TasksMax=1024

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable jarvis-agent-runner >/dev/null
systemctl restart jarvis-agent-runner
echo "agent runner $tag installed"
