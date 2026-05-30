#!/usr/bin/env bash
# set-cloudflare-secrets.sh
#
# One-time setup: generates + sets the four production secrets the demo-a2a
# Worker needs. Re-run is safe but overwrites existing values.
#
# Secrets generated internally and piped directly to `wrangler secret put`
# via stdin — they never appear in stdout, transcript, or shell history.
# The only thing printed is the A2A master EOA's PUBLIC address so you can
# verify the key was generated.
#
#   SESSION_JWT_SECRETS    — kid:hex64 (HS256 session signing)
#   CSRF_SECRET            — 0x-prefixed hex64 (HMAC for CSRF tokens)
#   A2A_SESSION_SECRET     — 0x-prefixed hex64 (AAD-bound payload encryption)
#   A2A_MASTER_PRIVATE_KEY — secp256k1 private key (fresh EOA, demo-only)
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
echo ""
echo "Fresh A2A master EOA address: $A2A_ADDR"
echo "  (private key was piped directly to Cloudflare — never stored locally,"
echo "   never printed. Address is safe to share publicly.)"
echo ""
echo "Verify with:"
echo "  cd $APP_DIR && wrangler secret list --env $ENV"
