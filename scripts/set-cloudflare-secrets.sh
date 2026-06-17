#!/usr/bin/env bash
# set-cloudflare-secrets.sh
#
# One-time setup: generates + sets the production secrets the demo-a2a +
# demo-mcp Workers need. Re-run is safe but overwrites existing values.
#
# Secrets generated internally and piped directly to `wrangler secret put`
# via stdin — they never appear in stdout, transcript, or shell history.
# The only thing printed is the A2A master EOA's PUBLIC address so you can
# verify the key was generated.
#
# demo-a2a (Worker):
#   SESSION_JWT_SECRETS    — kid:hex64 (HS256 session signing)
#   CSRF_SECRET            — 0x-prefixed hex64 (HMAC for CSRF tokens)
#   A2A_SESSION_SECRET     — 0x-prefixed hex64 (AAD-bound payload encryption)
#   A2A_MASTER_PRIVATE_KEY — secp256k1 private key (fresh EOA, demo-only)
#   RPC_URL                — Base Sepolia RPC (sourced from .env.deploy.local)
#
# demo-mcp (Worker):
#   RPC_URL                — Base Sepolia RPC (same value as demo-a2a)
#
# Without RPC_URL on either Worker, viem throws
# `UrlRequiredError: No URL was provided to the Transport` the first time
# a route reaches a `readContract` / `http(env.RPC_URL)` call. The PII
# read path is the canonical trigger because it crosses both workers.
#
# Usage:
#   bash scripts/set-cloudflare-secrets.sh                # env=production
#   ENV=staging bash scripts/set-cloudflare-secrets.sh    # alternate env

set -euo pipefail
cd "$(dirname "$0")/.."

ENV=${ENV:-production}
APP_DIR=apps/demo-a2a

for cmd in openssl wrangler cast node; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found in PATH"; exit 1; }
done

# Confirm wrangler login
wrangler whoami >/dev/null 2>&1 || { echo "ERROR: not logged into Cloudflare. Run: wrangler login"; exit 1; }

# Source RPC for both workers from .env.deploy.local (the same file the
# contracts deploy script reads).
if [ -f .env.deploy.local ]; then
  set -a; source .env.deploy.local; set +a
fi
if [ -z "${BASE_SEPOLIA_RPC:-}" ]; then
  echo "ERROR: BASE_SEPOLIA_RPC not set (expected in .env.deploy.local)."
  echo "  Without it RPC_URL cannot be pushed to either Worker."
  exit 1
fi

echo "Setting demo-a2a Worker secrets (env=$ENV)…"

# 1. SESSION_JWT_SECRETS  ("kid:hex" format expected by connect-auth.sessions)
KID="prodkid$(openssl rand -hex 4)"
printf '%s:%s' "$KID" "$(openssl rand -hex 32)" \
  | (cd "$APP_DIR" && wrangler secret put SESSION_JWT_SECRETS --env "$ENV") >/dev/null
echo "  ✓ SESSION_JWT_SECRETS  (kid=$KID)"

# 2. CSRF_SECRET
printf '0x%s' "$(openssl rand -hex 32)" \
  | (cd "$APP_DIR" && wrangler secret put CSRF_SECRET --env "$ENV") >/dev/null
echo "  ✓ CSRF_SECRET"

# 3. A2A_SESSION_SECRET
printf '0x%s' "$(openssl rand -hex 32)" \
  | (cd "$APP_DIR" && wrangler secret put A2A_SESSION_SECRET --env "$ENV") >/dev/null
echo "  ✓ A2A_SESSION_SECRET"

# 4. Signer backend — branch on A2A_KMS_BACKEND.
#    'gcp-kms'   → set GCP_SERVICE_ACCOUNT_JSON from .gcp-service-account.local.json
#    other/unset → generate a fresh local EOA into A2A_MASTER_PRIVATE_KEY
KMS_BACKEND_VALUE="${A2A_KMS_BACKEND:-local-aes}"
if [ "$KMS_BACKEND_VALUE" = "gcp-kms" ]; then
  GCP_FILE=".gcp-service-account.local.json"
  if [ ! -f "$GCP_FILE" ]; then
    echo "ERROR: A2A_KMS_BACKEND=gcp-kms but $GCP_FILE not found."
    echo "  Place your service-account JSON at $GCP_FILE (gitignored)."
    echo "  Then re-run: A2A_KMS_BACKEND=gcp-kms bash scripts/set-cloudflare-secrets.sh"
    exit 1
  fi
  # Validate it parses + has the fields GcpKmsSigner needs, then pipe to wrangler.
  if ! node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (!j.client_email || !j.private_key) { console.error("missing client_email/private_key"); process.exit(1); }
  ' "$GCP_FILE"; then
    echo "ERROR: $GCP_FILE is not a valid service-account JSON (need client_email + private_key)"
    exit 1
  fi
  cat "$GCP_FILE" | (cd "$APP_DIR" && wrangler secret put GCP_SERVICE_ACCOUNT_JSON --env "$ENV") >/dev/null
  A2A_ADDR="(set via GCP KMS — run scripts/deploy-cloudflare.ts to fetch from cloud)"
  echo "  ✓ GCP_SERVICE_ACCOUNT_JSON  (from $GCP_FILE)"
else
  # Fresh local EOA. Capture once, expose only address, pipe the private key
  # directly to wrangler stdin via a node parser.
  WALLET_JSON="$(cast wallet new --json)"
  A2A_ADDR="$(printf '%s' "$WALLET_JSON" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8"))[0].address)')"
  # Pipe key into wrangler without writing it to any variable that prints.
  # node runs in a subprocess; its stdout flows straight into the wrangler stdin
  # pipe, then node's process exits and the value is gone from that process.
  printf '%s' "$WALLET_JSON" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8"))[0].private_key)' \
    | (cd "$APP_DIR" && wrangler secret put A2A_MASTER_PRIVATE_KEY --env "$ENV") >/dev/null
  # Clear the WALLET_JSON variable now that we're done.
  unset WALLET_JSON
  echo "  ✓ A2A_MASTER_PRIVATE_KEY  (fresh local EOA)"
fi
# 5. RPC_URL — set on BOTH demo-a2a and demo-mcp. Each Worker's
#    `c.env.RPC_URL` feeds viem's http() transport; without it, every
#    on-chain read fails with `UrlRequiredError`. demo-a2a uses it for
#    the relayer + sponsored userOps; demo-mcp uses it for delegation
#    on-chain checks (ERC-1271, revoke status) inside the PII read path.
printf '%s' "$BASE_SEPOLIA_RPC" \
  | (cd "$APP_DIR" && wrangler secret put RPC_URL --env "$ENV") >/dev/null
echo "  ✓ RPC_URL  (demo-a2a)"

printf '%s' "$BASE_SEPOLIA_RPC" \
  | (cd apps/demo-mcp && wrangler secret put RPC_URL --env "$ENV") >/dev/null
echo "  ✓ RPC_URL  (demo-mcp)"

# 6. VAULT_MASTER_KEY — demo-mcp ONLY. Master secret for the vault's LocalAesProvider
#    DEK-wrapping backend (spec 277 Phase 2 envelope encryption). Honored from
#    $VAULT_MASTER_KEY if set; otherwise a fresh 32-byte value is generated so the
#    secret exists. TESTNET-DEMO GRADE — a managed KMS backend MUST replace this
#    before any real-value data lands (A2A_ALLOW_LOCAL_ENVELOPE_KEY logs a warning).
VAULT_MASTER_KEY="${VAULT_MASTER_KEY:-$(openssl rand -hex 32)}"
printf '%s' "$VAULT_MASTER_KEY" \
  | (cd apps/demo-mcp && wrangler secret put VAULT_MASTER_KEY --env "$ENV") >/dev/null
unset VAULT_MASTER_KEY
echo "  ✓ VAULT_MASTER_KEY  (demo-mcp)"

# 7. OAUTH_SIGNING_SECRET — demo-mcp ONLY. HS256 signing secret for the OAuth
#    ingress (spec 277 Phase 6): the demo authorization endpoint mints tokens
#    with it and /mcp validates bearer tokens against it. Honored from
#    $OAUTH_SIGNING_SECRET if set; otherwise a fresh 32-byte value is generated.
#    Demo-grade — stands in for a real authorization server + JWKS; the token is
#    never trusted as authority (the entitlement→KAS→audit chain re-runs server-side).
OAUTH_SIGNING_SECRET="${OAUTH_SIGNING_SECRET:-$(openssl rand -hex 32)}"
printf '%s' "$OAUTH_SIGNING_SECRET" \
  | (cd apps/demo-mcp && wrangler secret put OAUTH_SIGNING_SECRET --env "$ENV") >/dev/null
unset OAUTH_SIGNING_SECRET
echo "  ✓ OAUTH_SIGNING_SECRET  (demo-mcp)"

echo ""
echo "Fresh A2A master EOA address: $A2A_ADDR"
echo "  (private key was piped directly to Cloudflare — never stored locally,"
echo "   never printed. Address is safe to share publicly.)"
echo ""
echo "Verify with:"
echo "  cd $APP_DIR && wrangler secret list --env $ENV"
echo "  cd apps/demo-mcp && wrangler secret list --env $ENV"
