#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 box, run as root:  bash setup.sh
# Node 22 + pnpm 10.33, Solana CLI 3.1.10 (Agave), Caddy, a `rescu` user, /opt/rescu, firewall.
set -euo pipefail

apt-get update -y
apt-get install -y curl ca-certificates gnupg rsync build-essential pkg-config libssl-dev libudev-dev ufw debian-keyring debian-archive-keyring apt-transport-https bzip2

# Node 22 (NodeSource) + pnpm (global, so the rescu user and systemd see the same binary)
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g pnpm@10.33.0

# Caddy (official apt repo)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# The service user and the app directory
id rescu >/dev/null 2>&1 || useradd -m -s /bin/bash rescu
mkdir -p /opt/rescu && chown rescu:rescu /opt/rescu
install -d -m 700 -o rescu -g rescu /home/rescu/.config /home/rescu/.config/rescu

# Solana CLI 3.1.10 (Agave) for the rescu user
sudo -iu rescu bash -c 'test -x ~/.local/share/solana/install/active_release/bin/solana-test-validator || sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.10/install)"'

# Validator limits (solana-test-validator wants lots of open files and mmaps)
cat > /etc/sysctl.d/21-solana.conf <<'SYS'
vm.max_map_count = 1000000
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
SYS
sysctl --system >/dev/null

# Only SSH and HTTP(S) from outside; the validator, server and web listen behind Caddy
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "setup done: node $(node -v), pnpm $(pnpm -v), caddy $(caddy version | cut -d' ' -f1)"
