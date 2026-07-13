#!/usr/bin/env bash
# D-P1-3 — out-of-band inventory export of the tier-1 durable vault-key metadata.
#
# The `vault_key_bindings` D1 table is the AUTHORITATIVE map owner_address -> (kms_key_ref, the
# person-signed VaultKeyAuthorization envelope). A D1 restore-to-earlier-snapshot / bad migration that
# loses the table leaves ciphertext intact but its addressing (which KEK decrypts a given owner) and its
# authorization envelope gone. This script exports the whole table to a timestamped JSON so a lost/rolled-
# back D1 can be reconstructed. Run it on a schedule and store the output OFF Cloudflare (the export is the
# backup). See docs/runbooks/vault-key-durability.md for the full recovery procedure.
#
# Note: the kms_key_ref cryptoKey id embeds the owner address but its CASING is not canonical across rows
# (some provisioned checksummed, some lowercase), and GCP key ids are case-sensitive — so the exact ref is
# NOT reliably reconstructible from owner_address alone. This export is the primary recovery source; the
# GCP-key-listing lowercase-match (in the runbook) is the secondary, procedure-not-fallback path.
#
# Usage: scripts/export-vault-key-bindings.sh [OUT_DIR]   (default OUT_DIR: ./backups/vault-key-bindings)
set -euo pipefail

OUT_DIR="${1:-backups/vault-key-bindings}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OUT_DIR}/vault_key_bindings-${STAMP}.json"
mkdir -p "${OUT_DIR}"

echo "[export] dumping vault_key_bindings from PROD D1 (demo-mcp) -> ${OUT}"
( cd "$(dirname "$0")/../apps/demo-mcp" && \
  npx wrangler d1 execute DB --env production --remote --json \
    --command "SELECT owner_address, server_id, vault_id, kms_key_ref, allowed_resources, classification_ceiling, ops, expires_at, authorization_json, authorization_hash, created_at, updated_at, revoked_at FROM vault_key_bindings ORDER BY owner_address, server_id;" \
) > "${OUT}"

ROWS="$(grep -c '"owner_address"' "${OUT}" || true)"
echo "[export] wrote ${OUT} (${ROWS} binding row(s))"
echo "[export] STORE THIS OFF-CLOUDFLARE (e.g. GCS/S3 with versioning). It is tier-1 durable metadata."
