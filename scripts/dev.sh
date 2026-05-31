#!/usr/bin/env bash
# Local end-to-end dev orchestration for the all-Cloudflare demo stack.
#
#   1. Anvil on :8545
#   2. forge script Deploy.s.sol → deployments-anvil.json
#   3. gen-dev-vars.ts → .dev.vars for demo-a2a + demo-mcp
#   4. wrangler d1 migrations apply demo-mcp --local
#   5. wrangler dev for demo-a2a (:8787) + demo-mcp (:8788) + vite dev for demo-web (:5173)
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
  echo "ERROR: anvil not found. Install Foundry: https://book.getfoundry.sh/getting-started/installation"
  exit 1
fi

ANVIL_PORT=${ANVIL_PORT:-8545}

# 1. Anvil
echo "[1/5] Starting Anvil on :$ANVIL_PORT…"
anvil --port "$ANVIL_PORT" --silent &
ANVIL_PID=$!
sleep 1

# 2. Deploy contracts
if [ -d packages/contracts/lib ] && [ "$(ls -A packages/contracts/src 2>/dev/null)" ]; then
  echo "[2/5] Deploying contracts to Anvil…"
  (cd packages/contracts && pnpm deploy:anvil)
else
  echo "[2/5] Contracts not built. Run: cd packages/contracts && bash setup.sh && pnpm build"
  exit 1
fi

# 3. Generate .dev.vars for the Workers
echo "[3/5] Generating .dev.vars for demo Workers…"
pnpm tsx scripts/gen-dev-vars.ts

# 4. Apply D1 migrations to the local SQLite
echo "[4/5] Applying D1 migrations to local demo-mcp database…"
(cd apps/demo-mcp && CI=1 pnpm d1:migrate:local) || echo "  (D1 migrate failed — wrangler dev will retry on startup)"

# 5. Start workers + web
echo "[5/5] Starting demo-a2a (:8787) + demo-mcp (:8788) + demo-web (:5173) + demo-web-pro (:5273) + demo-web-recovery (:5373)…"
pnpm --filter @agenticprimitives-demo/a2a dev &
pnpm --filter @agenticprimitives-demo/mcp dev &
pnpm --filter @agenticprimitives-demo/web dev &
pnpm --filter @agenticprimitives-demo/web-pro dev &
pnpm --filter @agenticprimitives-demo/web-recovery dev &

cat <<EOF

────────────────────────────────────────────────────────────
demo-web           http://127.0.0.1:5173
demo-web-pro       http://127.0.0.1:5273
demo-web-recovery  http://127.0.0.1:5373
demo-a2a           http://127.0.0.1:8787/health  (Cloudflare Worker via wrangler dev)
demo-mcp           http://127.0.0.1:8788/health  (Cloudflare Worker via wrangler dev)
anvil              http://127.0.0.1:$ANVIL_PORT
────────────────────────────────────────────────────────────

Press Ctrl-C to stop everything.
EOF

wait
