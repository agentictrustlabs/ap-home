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
APP_DIR=apps/agent-runtime

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

# 3b. A2A_INTERNAL_MARKER (spec 341 §7) — the in-Worker DO↔DO marker.
#     Generated HERE and never written anywhere: setter and checker are the same deployed Worker, so
#     nothing else ever needs to know it. It used to be A2A_CUSTODY_BRIDGE_SECRET, which meant a leak
#     of the Home↔demo-a2a custody secret also opened `internal.*` against any principal — one value
#     carrying two very different trust levels. Rotating this one now affects nothing else.
#     demo-a2a ONLY: the Home has no use for it and must not be given it.
printf '0x%s' "$(openssl rand -hex 32)" \
  | (cd "$APP_DIR" && wrangler secret put A2A_INTERNAL_MARKER --env "$ENV") >/dev/null
echo "  ✓ A2A_INTERNAL_MARKER"

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
  # Phase A / D-P0-1: A2A_MASTER_PRIVATE_KEY is now ONLY the relay/paymaster/bundler signer (local-aes path),
  # split from the custody-derivation root (A2A_CUSTODY_ROOT_KEY, set below). The relay signer is FREELY
  # ROTATABLE — regenerating it only changes the relayer (re-set paymaster.verifyingSigner() on-chain), it
  # NEVER orphans custody. So no never-regen guard here anymore. Fresh local EOA; expose only the address.
  WALLET_JSON="$(cast wallet new --json)"
  A2A_ADDR="$(printf '%s' "$WALLET_JSON" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8"))[0].address)')"
  printf '%s' "$WALLET_JSON" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8"))[0].private_key)' \
    | (cd "$APP_DIR" && wrangler secret put A2A_MASTER_PRIVATE_KEY --env "$ENV") >/dev/null
  unset WALLET_JSON
  echo "  ✓ A2A_MASTER_PRIVATE_KEY  (fresh local EOA — relay signer only, rotatable)"
fi

# 4b. Phase A / D-P0-1: the OIDC custody-DERIVATION ROOT — a DEDICATED key (all backends), the HKDF ikm for
#     every C_sub → every Google/email SA address. This key must NEVER rotate: regenerating it re-derives a
#     different SA for every subject, orphaning the old accounts + all their vault data (unrecoverable even by
#     ADR-0011). The never-regen guard lives HERE now (moved off the relay master, which is freely rotatable).
#     Refuse to overwrite an existing root unless the operator explicitly accepts the orphaning — after a
#     migration (persist (iss,sub)→SA via SUBJECT_SA_MAP, which the resolver already fail-closes on) or a full
#     reset — via A2A_ALLOW_FRESH_CUSTODY_ROOT=1. See findings.yaml D-P0-1.
EXISTING_ROOT="$( (cd "$APP_DIR" && wrangler secret list --env "$ENV" 2>/dev/null) | grep -c 'A2A_CUSTODY_ROOT_KEY' || true )"
if [ "${EXISTING_ROOT:-0}" != "0" ] && [ "${A2A_ALLOW_FRESH_CUSTODY_ROOT:-}" != "1" ]; then
  echo "ERROR: A2A_CUSTODY_ROOT_KEY is ALREADY set for env '$ENV' — it is the OIDC custody-derivation ROOT."
  echo "  Regenerating it ORPHANS every Google/email-custodied Smart Agent (new C_sub → new SA → old"
  echo "  account + all vault data stranded — findings.yaml D-P0-1). Leave it as-is (the common case)."
  echo "  To ROTATE anyway (full reset / accepted data loss), re-run with A2A_ALLOW_FRESH_CUSTODY_ROOT=1."
  exit 1
fi
CUSTODY_JSON="$(cast wallet new --json)"
printf '%s' "$CUSTODY_JSON" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8"))[0].private_key)' \
  | (cd "$APP_DIR" && wrangler secret put A2A_CUSTODY_ROOT_KEY --env "$ENV") >/dev/null
unset CUSTODY_JSON
echo "  ✓ A2A_CUSTODY_ROOT_KEY  (fresh — the never-rotate OIDC custody root, split from the relay signer)"

# 5. RPC_URL — set on BOTH demo-a2a and demo-mcp. Each Worker's
#    `c.env.RPC_URL` feeds viem's http() transport; without it, every
#    on-chain read fails with `UrlRequiredError`. demo-a2a uses it for
#    the relayer + sponsored userOps; demo-mcp uses it for delegation
#    on-chain checks (ERC-1271, revoke status) inside the PII read path.
printf '%s' "$BASE_SEPOLIA_RPC" \
  | (cd "$APP_DIR" && wrangler secret put RPC_URL --env "$ENV") >/dev/null
echo "  ✓ RPC_URL  (demo-a2a)"

printf '%s' "$BASE_SEPOLIA_RPC" \
  | (cd apps/vault && wrangler secret put RPC_URL --env "$ENV") >/dev/null
echo "  ✓ RPC_URL  (demo-mcp)"

# 6. (removed) VAULT_MASTER_KEY — spec 278 P4 deleted the global vault master key. The
#    vault is now per-person-keyed: each person's KEK lives in GCP Cloud KMS and is
#    resolved from their VaultKeyBinding. demo-mcp uses GCP_SERVICE_ACCOUNT_JSON (set
#    above when the gcp-kms backend is selected) to wield those per-person KEKs. There
#    is no global key to seed (VKB-D1).

# 7. OAUTH_SIGNING_SECRET — demo-mcp ONLY. HS256 signing secret for the OAuth
#    ingress (spec 277 Phase 6): the demo authorization endpoint mints tokens
#    with it and /mcp validates bearer tokens against it. Honored from
#    $OAUTH_SIGNING_SECRET if set; otherwise a fresh 32-byte value is generated.
#    Demo-grade — stands in for a real authorization server + JWKS; the token is
#    never trusted as authority (the entitlement→KAS→audit chain re-runs server-side).
OAUTH_SIGNING_SECRET="${OAUTH_SIGNING_SECRET:-$(openssl rand -hex 32)}"
printf '%s' "$OAUTH_SIGNING_SECRET" \
  | (cd apps/vault && wrangler secret put OAUTH_SIGNING_SECRET --env "$ENV") >/dev/null
unset OAUTH_SIGNING_SECRET
echo "  ✓ OAUTH_SIGNING_SECRET  (demo-mcp)"

# 8. GATEWAY_ASSERTION_SECRET — the spec-288 §6 edge admission HMAC. The SAME value MUST be on demo-edge
#    (signer) + demo-mcp + demo-a2a (verifiers). The edge is ON by default, so the verifiers REQUIRE a valid
#    assertion — a mismatch/absence → 401 on every edge-fronted request. Honored from
#    $GATEWAY_ASSERTION_SECRET if set; else a fresh value is generated and set consistently across all three.
#    printf '%s' (no trailing newline) — the edge signer does NOT .trim(), so a newline would break the HMAC.
GATEWAY_ASSERTION_SECRET="${GATEWAY_ASSERTION_SECRET:-$(openssl rand -hex 32)}"
for ga_app in demo-edge demo-mcp demo-a2a; do
  printf '%s' "$GATEWAY_ASSERTION_SECRET" \
    | (cd "apps/$ga_app" && wrangler secret put GATEWAY_ASSERTION_SECRET --env "$ENV") >/dev/null
  echo "  ✓ GATEWAY_ASSERTION_SECRET  ($ga_app)"
done
unset GATEWAY_ASSERTION_SECRET

echo ""
echo "Fresh A2A master EOA address: $A2A_ADDR"
echo "  (private key was piped directly to Cloudflare — never stored locally,"
echo "   never printed. Address is safe to share publicly.)"
echo ""
echo "Verify with:"
echo "  cd $APP_DIR && wrangler secret list --env $ENV"
echo "  cd apps/vault && wrangler secret list --env $ENV"
