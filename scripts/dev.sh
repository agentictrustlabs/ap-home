#!/usr/bin/env bash
# Local end-to-end dev orchestration:
#   1. Start Anvil
#   2. Deploy contracts
#   3. Start demo-a2a, demo-mcp, demo-web in parallel
#
# Ctrl-C cleans everything up.

set -euo pipefail

cd "$(dirname "$0")/.."

cleanup() {
  echo ""
  echo "Stopping demo processes…"
  jobs -p | xargs -r kill 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

if ! command -v anvil >/dev/null 2>&1; then
  echo "ERROR: anvil not found. Install foundry: https://book.getfoundry.sh/getting-started/installation"
  exit 1
fi

ANVIL_PORT=${ANVIL_PORT:-8545}
A2A_PORT=${A2A_PORT:-8787}
MCP_PORT=${MCP_PORT:-8788}
WEB_PORT=${WEB_PORT:-5173}

# 1. Anvil
echo "[1/3] Starting Anvil on :$ANVIL_PORT…"
anvil --port "$ANVIL_PORT" --silent &
ANVIL_PID=$!
sleep 1

# 2. Deploy contracts (skips if Deploy.s.sol is still a stub)
if [ -d apps/contracts/lib ] && [ -d apps/contracts/src ] && [ "$(ls -A apps/contracts/src 2>/dev/null)" ]; then
  echo "[2/3] Deploying contracts to Anvil…"
  (cd apps/contracts && pnpm deploy:anvil) || echo "  (contract deploy skipped — vendoring not yet complete)"
else
  echo "[2/3] Skipping contract deploy (apps/contracts not yet vendored / setup not run)."
  echo "      Run: cd apps/contracts && bash setup.sh && pnpm build"
fi

# 3. Start the three apps in parallel
echo "[3/3] Starting demo-a2a, demo-mcp, demo-web…"
PORT=$A2A_PORT pnpm --filter @agenticprimitives-demo/a2a dev &
PORT=$MCP_PORT pnpm --filter @agenticprimitives-demo/mcp dev &
pnpm --filter @agenticprimitives-demo/web dev &

cat <<EOF

────────────────────────────────────────────────────────────
demo-web    http://127.0.0.1:$WEB_PORT
demo-a2a    http://127.0.0.1:$A2A_PORT/health
demo-mcp    http://127.0.0.1:$MCP_PORT/health
anvil       http://127.0.0.1:$ANVIL_PORT
────────────────────────────────────────────────────────────

Press Ctrl-C to stop everything.
EOF

wait
