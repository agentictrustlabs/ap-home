#!/usr/bin/env bash
# MOVE AN ESTATE'S VAULT KEKS ONTO AKCS — run ONLY once the two caller tokens exist.
#
#   scripts/adopt-akcs.sh imbnet <vault-token-file> <runtime-token-file>
#
# WHY THIS IS A SCRIPT AND NOT A COMMITTED CONFIG. Flipping `A2A_KMS_BACKEND` to `agentic-kms` without a
# working token breaks the A2A→MCP service MAC in both directions, and a half-flipped estate cannot sign
# anyone in. The vars and the secrets must land together, so they land here, together, or not at all.
#
# COST: DERIVED KEYS ONLY. `AZURE_HSM_DIRECT` is a real Azure Key Vault HSM key, billed per key. There are
# a couple of HSM ROOT keys and that is the whole Azure spend; every agent key is CVM_WRAPPED/CVM_DERIVED
# from a root inside the confidential VM and costs nothing per agent. Both callers are bound without
# HSM-direct and both Workers refuse it, so a per-person KEK cannot quietly become a billable key.
#
# THE TENANT IS THE ESTATE. An AKCS tenant is a derivation root ("MAC keys are derived from the tenant
# root"), so imbnet gets its own, `imb`. faithnet-b and skills-a2a share `faithnet` because they are a
# second deployment OF faithnet and a service WITHIN it — imbnet is a different estate, and sharing a seed
# would dissolve the separate custody that makes it one.
#
# WHAT DOES *NOT* MOVE: `A2A_CUSTODY_KMS_BACKEND` stays `local-aes`. A person's KMS-custodied home IS a
# CREATE2 address over their derived custodian, so changing the custody root derives a DIFFERENT — empty —
# Smart Agent and locks out every existing member. faithnet carries the same staged-cutover note for the
# same reason. Only the VAULT KEK path and the service MAC move.
set -euo pipefail
cd "$(dirname "$0")/.."
EST="${1:?usage: adopt-akcs.sh <estate> <vault-token-file> <runtime-token-file>}"
VT="${2:?vault caller token file}"; RT="${3:?runtime caller token file}"
[ -s "$VT" ] && [ -s "$RT" ] || { echo "both token files must be non-empty"; exit 1; }
export CLOUDFLARE_ACCOUNT_ID=5da2feaa56593839672948e16c6e809d

echo "1/3  secrets"
npx -y wrangler secret put AKCS_TOKEN --env "$EST" -c apps/vault/wrangler.toml         < "$VT" >/dev/null && echo "  set  imb-vault AKCS_TOKEN"
npx -y wrangler secret put AKCS_TOKEN --env "$EST" -c apps/agent-runtime/wrangler.toml < "$RT" >/dev/null && echo "  set  imb-runtime AKCS_TOKEN"

echo "2/3  vars — set these in wrangler.toml BEFORE running, then deploy:"
cat <<'VARS'
  apps/vault/wrangler.toml        [env.imbnet.vars]
    A2A_KMS_BACKEND = "agentic-kms"
    AKCS_BASE_URL   = "https://akcs-pilot.faithnet.io"
    AKCS_TENANT_ID  = "imb"
    AKCS_ACCEPTED_PROTECTION_LEVELS = "CVM_WRAPPED,CVM_DERIVED"   # never AZURE_HSM_DIRECT — that one bills
    # drop DEMO_VAULT_LOCAL_KEK_SECRET — it can never apply in a deployed Worker

  apps/agent-runtime/wrangler.toml [env.imbnet.vars]
    A2A_KMS_BACKEND          = "agentic-kms"   # the MAC mechanism BOTH halves of the hop must agree on
    A2A_CUSTODY_KMS_BACKEND  = "local-aes"     # UNCHANGED — moving this orphans every existing home
    AKCS_BASE_URL            = "https://akcs-pilot.faithnet.io"
    AKCS_TENANT_ID           = "imb"
    AKCS_ACCEPTED_PROTECTION_LEVELS = "CVM_WRAPPED,CVM_DERIVED"
VARS

echo "3/3  deploy vault then runtime, and check:"
echo "  curl -s -X POST https://imb-vault.richardpedersen3.workers.dev/custody/vault-key/provision \\"
echo "       -H 'content-type: application/json' -d '{\"owner\":\"0x…\"}'"
echo "  a 501 naming GCP means the vars did not land; a 401 means the token is wrong or the caller lacks the op."
