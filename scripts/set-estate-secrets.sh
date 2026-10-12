#!/usr/bin/env bash
# Put an estate's secrets on its four Workers. Values come from `.estate-<name>.local` (0600, gitignored,
# written by scripts/bootstrap-estate.mts); none is ever printed, and an unset one is SKIPPED with the
# consequence named — a Worker deployed without it fails closed on the path that needs it, which is the
# honest outcome, not a quiet degradation.
#
# Each secret goes only to the Workers that must agree on it:
#   A2A_MAC_SECRET            runtime + vault   (the service MAC on the A2A→MCP hop)
#   GATEWAY_ASSERTION_SECRET  runtime + vault + edge
#   A2A_CUSTODY_BRIDGE_SECRET runtime           (the Home holds the other half, as a Vercel env var)
#
# Usage: scripts/set-estate-secrets.sh <estate>        e.g. scripts/set-estate-secrets.sh imbnet
set -euo pipefail
cd "$(dirname "$0")/.."
EST="${1:?usage: set-estate-secrets.sh <estate>}"
F=".estate-${EST}.local"
[ -f "$F" ] || { echo "no $F — run: npx tsx scripts/bootstrap-estate.mts --estate $EST"; exit 1; }
set -a; . "./$F"; set +a
put() { local cfg="$1" name="$2" why="$3"; local val="${!name:-}"
  if [ -z "$val" ]; then echo "  skip  $name — $why"; return; fi
  printf '%s' "$val" | npx -y wrangler secret put "$name" --env "$EST" -c "$cfg" >/dev/null && echo "  set   $name"; }

echo "imb-vault (apps/vault) — the record:"
for n in RPC_URL A2A_MAC_SECRET GATEWAY_ASSERTION_SECRET OAUTH_SIGNING_SECRET DEMO_VAULT_LOCAL_KEK_SECRET; do
  put apps/vault/wrangler.toml "$n" "every vault read refuses"; done

echo "imb-runtime (apps/agent-runtime) — the agent:"
for n in RPC_URL SESSION_JWT_SECRETS CSRF_SECRET A2A_SESSION_SECRET A2A_MASTER_PRIVATE_KEY A2A_INTERACTIONS_SESSION_PRIVATE_KEY A2A_CUSTODY_ROOT_KEY A2A_MAC_SECRET A2A_CUSTODY_BRIDGE_SECRET GATEWAY_ASSERTION_SECRET GEMINI_API_KEY; do
  put apps/agent-runtime/wrangler.toml "$n" "the path that needs it fails closed"; done

# Spec 341 §7 — the IN-WORKER MARKER. Generated here and piped straight to `wrangler secret put`: it is
# never written to the estate file, never shared with the Home, and never needs rotating in step with
# anything else, because setter and checker are the same deployed code reading the same binding. Without
# it every `internal.*` op is refused loudly — a Home onboarding dies at `POST /harness/runs` with a 500,
# which is how imbnet found it (2026-10-11).
echo "imb-runtime — the in-Worker marker (generated, never stored):"
if node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))' \
   | npx -y wrangler secret put A2A_INTERNAL_MARKER --env "$EST" -c apps/agent-runtime/wrangler.toml >/dev/null; then
  echo "  set   A2A_INTERNAL_MARKER"
else
  echo "  FAIL  A2A_INTERNAL_MARKER — every internal op will be refused"
fi

echo "imb-edge (apps/edge) — admission:"
for n in RPC_URL GATEWAY_ASSERTION_SECRET; do put apps/edge/wrangler.toml "$n" "admission refuses"; done

echo "imb-home-mcp (apps/home-mcp) — Claude's entrance:"
for n in HOME_MCP_PRIVATE_KEY HOME_MCP_ACT_KEY TOKEN_SECRET; do put apps/home-mcp/wrangler.toml "$n" "no client can connect"; done

echo "done — the Home's half (A2A_CUSTODY_BRIDGE_SECRET, DEMO_SIGNER_SECRET, the broker JWK) is a Vercel env var, not a wrangler secret."
