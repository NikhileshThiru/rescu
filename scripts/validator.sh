#!/usr/bin/env bash
# Local Solana validator with the Rescu program preloaded (upgradeable, so it can be
# redeployed without wiping state). The same script runs on the Vultr box.
#   pnpm chain:validator            fresh ledger (default)
#   KEEP_LEDGER=1 pnpm chain:validator   keep existing state
set -euo pipefail
cd "$(dirname "$0")/.."

PROGRAM_ID=$(solana address -k target/deploy/rescu-keypair.json)
UPGRADE_AUTHORITY=${UPGRADE_AUTHORITY:-$(solana address)}
LEDGER=${LEDGER:-.ledger}
RESET_FLAG=--reset
[[ -n "${KEEP_LEDGER:-}" ]] && RESET_FLAG=

exec solana-test-validator \
  --ledger "$LEDGER" \
  $RESET_FLAG \
  --bind-address "${BIND_ADDRESS:-127.0.0.1}" \
  --rpc-port "${RPC_PORT:-8899}" \
  --limit-ledger-size "${LEDGER_LIMIT:-50000000}" \
  --upgradeable-program "$PROGRAM_ID" target/deploy/rescu.so "$UPGRADE_AUTHORITY" \
  --quiet "$@"
