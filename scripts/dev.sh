#!/usr/bin/env bash
# Local end-to-end dev orchestration for the all-Cloudflare demo stack.
#
#   1. Anvil on :8545
#   2. forge script Deploy.s.sol → deployments-anvil.json
#   3. gen-dev-vars.ts → .dev.vars for home-runtime + home-vault
#   4. wrangler d1 migrations apply home-vault --local
#   5. wrangler dev for home-runtime (:8787) + home-vault (:8788) + home-edge (:8789) + vite dev for demo-web (:5173)
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

if ! command -v anvil >/dev/null 2>&1 && ! curl -sf -m 2 "http://127.0.0.1:${ANVIL_PORT:-8545}" >/dev/null 2>&1; then
  echo "ERROR: no local chain on :${ANVIL_PORT:-8545} and anvil not found. Start faithnet (faithchain repo) or install Foundry."
  exit 1
fi

ANVIL_PORT=${ANVIL_PORT:-8545}

# 1. Local chain: reuse one that is already serving :$ANVIL_PORT (e.g. the faithchain/faithnet
#    docker stack — a drop-in for anvil: same port, chain id 31337, the 10 dev accounts); otherwise start Anvil.
if curl -sf -m 2 -X POST "http://127.0.0.1:$ANVIL_PORT" -H 'content-type: application/json' \
     --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' >/dev/null; then
  echo "[1/5] Using the local chain already serving :$ANVIL_PORT (faithnet or anvil)."
  EXISTING_CHAIN=1
else
  echo "[1/5] Starting Anvil on :$ANVIL_PORT…"
  anvil --port "$ANVIL_PORT" --silent &
  ANVIL_PID=$!
  sleep 1
  EXISTING_CHAIN=0
fi

# 2. Deploy contracts (a fresh anvil needs them every run; a persistent chain keeps the last deployment —
#    set FORCE_DEPLOY=1 to redeploy there).
if [ "$EXISTING_CHAIN" = "1" ] && [ -f packages/contracts/deployments-anvil.json ] && [ "${FORCE_DEPLOY:-0}" != "1" ]; then
  echo "[2/5] Reusing packages/contracts/deployments-anvil.json on the existing chain (FORCE_DEPLOY=1 to redeploy)."
elif [ -d packages/contracts/lib ] && [ "$(ls -A packages/contracts/src 2>/dev/null)" ]; then
  echo "[2/5] Deploying contracts to :$ANVIL_PORT…"
  (cd packages/contracts && pnpm deploy:anvil)
else
  echo "[2/5] Contracts not built. Run: cd packages/contracts && bash setup.sh && pnpm build"
  exit 1
fi

# 3. Generate .dev.vars for the Workers
echo "[3/5] Generating .dev.vars for demo Workers…"
pnpm tsx scripts/gen-dev-vars.ts

# 4. Apply D1 migrations to the local SQLite
echo "[4/5] Applying D1 migrations to local home-vault database…"
(cd apps/vault && CI=1 pnpm d1:migrate:local) || echo "  (D1 migrate failed — wrangler dev will retry on startup)"

# 5. Start workers + web
echo "[5/5] Starting home-runtime (:8787) + home-vault (:8788) + home-edge (:8789) + demo-web (:5173) + demo-web-pro (:5273) + demo-web-recovery (:5373)…"
pnpm --filter @ap-home/agent-runtime dev &
pnpm --filter @ap-home/vault dev &
pnpm --filter @ap-home/edge dev &
pnpm --filter @agenticprimitives-demo/web dev &
pnpm --filter @agenticprimitives-demo/web-pro dev &
pnpm --filter @agenticprimitives-demo/web-recovery dev &

cat <<EOF

────────────────────────────────────────────────────────────
demo-web           http://127.0.0.1:5173
demo-web-pro       http://127.0.0.1:5273
demo-web-recovery  http://127.0.0.1:5373
home-runtime           http://127.0.0.1:8787/health  (Cloudflare Worker via wrangler dev)
home-vault           http://127.0.0.1:8788/health  (Cloudflare Worker via wrangler dev)
home-edge          http://127.0.0.1:8789/.well-known/agentic-authorization  (admission gateway; Service Bindings → home-runtime/home-vault)
local chain        http://127.0.0.1:$ANVIL_PORT  (faithnet or anvil)
────────────────────────────────────────────────────────────

Press Ctrl-C to stop everything.
EOF

wait
