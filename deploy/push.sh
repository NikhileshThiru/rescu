#!/usr/bin/env bash
# Push the app to the box, build it and (re)start everything. Run from the laptop:
#   deploy/push.sh <server ip>            (the box must have run deploy/setup.sh once)
# Sends: the repo (no node_modules, .git, docs or agent files), the built program + its keypair,
# ~/.config/rescu/*.json (admin/oracle/relayer/agent keys, chmod 600) and a production .env made
# from the local one. The presenter key is generated once into ~/.config/rescu/presenter-key.
set -euo pipefail
HOST=${1:?usage: deploy/push.sh <server ip>}
DOMAIN=${DOMAIN:-rescu.tech}
cd "$(dirname "$0")/.."
SSH=(ssh -o StrictHostKeyChecking=accept-new "root@$HOST")

KEYFILE=~/.config/rescu/presenter-key
if [[ ! -s $KEYFILE ]]; then
  head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$KEYFILE"
  chmod 600 "$KEYFILE"
fi
PRESENTER_KEY=$(cat "$KEYFILE")

# Production .env: the local one with the public URLs and the presenter key swapped in.
ENV_OUT=$(mktemp)
trap 'rm -f "$ENV_OUT"' EXIT
python3 - "$ENV_OUT" "$DOMAIN" "$PRESENTER_KEY" <<'PY'
import sys
out, domain, key = sys.argv[1:]
over = {
    "SOLANA_RPC_URL": "http://127.0.0.1:8899",
    "SOLANA_WS_URL": "ws://127.0.0.1:8900",
    "PUBLIC_RPC_URL": f"https://rpc.{domain}",
    "PUBLIC_SITE_URL": f"https://{domain}",
    "NEXT_PUBLIC_SITE_URL": f"https://{domain}",
    "NEXT_PUBLIC_API_URL": f"https://{domain}",
    "NEXT_PUBLIC_WS_URL": f"wss://{domain}/ws",
    "PRESENTER_KEY": key,
    "PORT": "4000",
}
lines, seen = [], set()
for line in open(".env"):
    k = line.split("=", 1)[0].strip()
    if k in over:
        lines.append(f"{k}={over[k]}\n"); seen.add(k)
    else:
        lines.append(line if line.endswith("\n") else line + "\n")
for k, v in over.items():
    if k not in seen: lines.append(f"{k}={v}\n")
open(out, "w").write("".join(lines))
PY

echo "== sync repo"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude target --exclude .ledger --exclude test-ledger \
  --exclude data/raw --exclude data/out --exclude .next --exclude .turbo \
  --exclude docs --exclude AGENTS.md --exclude CLAUDE.md --exclude .cursor --exclude .claude \
  --exclude .env --exclude '.env.*' --exclude '*.log' \
  ./ "root@$HOST:/opt/rescu/"
"${SSH[@]}" "mkdir -p /opt/rescu/target/deploy"
rsync -az target/deploy/rescu.so target/deploy/rescu-keypair.json "root@$HOST:/opt/rescu/target/deploy/"
rsync -az ~/.config/rescu/admin.json ~/.config/rescu/oracle.json ~/.config/rescu/relayer.json ~/.config/rescu/agent.json "root@$HOST:/home/rescu/.config/rescu/"
"${SSH[@]}" "test -f /home/rescu/.config/rescu/grok-usage.json" || rsync -az ~/.config/rescu/grok-usage.json "root@$HOST:/home/rescu/.config/rescu/"
rsync -az "$ENV_OUT" "root@$HOST:/opt/rescu/.env"
"${SSH[@]}" "chown -R rescu:rescu /opt/rescu /home/rescu/.config && chmod 600 /home/rescu/.config/rescu/*.json /opt/rescu/.env && sed -i 's/\r$//' /opt/rescu/scripts/*.sh"

echo "== install + build (as rescu)"
"${SSH[@]}" "sudo -iu rescu bash -lc 'cd /opt/rescu && pnpm install --frozen-lockfile && NEXT_PUBLIC_SITE_URL=https://$DOMAIN NEXT_PUBLIC_API_URL=https://$DOMAIN NEXT_PUBLIC_WS_URL=wss://$DOMAIN/ws pnpm --filter @rescu/web build'"

echo "== services + caddy"
"${SSH[@]}" "cp /opt/rescu/deploy/rescu-*.service /etc/systemd/system/ && cp /opt/rescu/deploy/Caddyfile /etc/caddy/Caddyfile && systemctl daemon-reload && systemctl enable rescu-validator rescu-server rescu-web >/dev/null && { systemctl is-active --quiet rescu-validator || { systemctl start rescu-validator && sleep 10; }; } && systemctl restart rescu-server rescu-web && systemctl reload caddy || systemctl restart caddy"
"${SSH[@]}" "systemctl --no-pager --lines=0 status rescu-validator rescu-server rescu-web caddy | grep -E '●|Active:'"
echo "done. Presenter link: https://$DOMAIN/?key=\$(cat $KEYFILE)"
