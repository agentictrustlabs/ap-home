# Per-person vault key ceremony (spec 278)

How a person goes from **fail-closed** (no binding ⇒ `vault_key_unauthorized`) to a **live**
per-person-keyed vault. There is **no global key** — each person's vault objects are wrapped
under that person's own GCP Cloud KMS KEK, and demo-mcp may wield it only because the person
SA signed a `VaultKeyAuthorization` naming this server + that KEK (VKB-D1, VKB-D3).

The flow has three parties: the **operator** (provisions the KEK), the **person** (their SA
signs the authorization via their connected custodian), and **demo-mcp** (verifies + binds).

## 1. Operator — provision the person's KEK (spec 276)

Each person SA gets its own HSM secp256k1-adjacent **symmetric** encrypt/decrypt key, with
per-key IAM (master-key separation). Use the spec-276 provisioning helper:

```bash
# identity label = the person SA address (opaque to the provisioner)
ap-provision-gcp \
  --project "$GCP_PROJECT" --location "$GCP_LOCATION" --key-ring "$VAULT_KEY_RING" \
  --identity "<personSA>" \
  --runtime-service-account "<demo-mcp-runtime-SA-email>" \
  --protection-level HSM
# → prints the cryptoKey resource name (the binding's `kmsKeyRef`) + grants the runtime SA
#   roles/cloudkms.signer/cryptoKeyEncrypterDecrypter scoped to THAT key only.
```

> Note: the spec-276 helper provisions **asymmetric signing** keys today; the vault KEK is a
> **symmetric** ENCRYPT_DECRYPT key (`GOOGLE_SYMMETRIC_ENCRYPTION`). Provision the symmetric
> key the same way (`--purpose=encryption`) or via the console; the per-key IAM rule is identical.

Set the runtime credential on demo-mcp (already wired in `set-cloudflare-secrets.sh` for the
gcp-kms backend):

```bash
GCP_SERVICE_ACCOUNT_JSON=... pnpm tsx scripts/set-cloudflare-secrets.sh   # sets it on demo-mcp
```

## 2. Person — sign the `VaultKeyAuthorization` (connected custodian)

The person's app (the home / connected-custodian surface) builds the unsigned authorization and
has the person SA sign its EIP-712 digest via the custody credential (passkey, or the `0x03`
approved-hash sentinel for passkey-only custodians — the same rail org-create uses):

```ts
import { buildVaultKeyAuthorization } from '<demo-mcp>/vault-key'; // or rebuild with delegation primitives
const { authorization, digest } = buildVaultKeyAuthorization(
  { CHAIN_ID, DELEGATION_MANAGER },
  {
    owner: personSA,
    vaultId: 'demo-mcp',
    kmsKeyRef,                              // from step 1
    serverKey: DEMO_MCP_DELEGATE_KEY,       // the host's authorized delegate
    allowedResources: ['person-pii', 'org-sensitive', 'profile'],
    classificationCeiling: 'regulated.high',
    ops: ['read', 'write'],
    expiresAt: '<ISO, e.g. +90d>',
    salt: <random bigint>,
  },
);
authorization.signature = await custodian.sign(digest);   // person SA signs (ERC-1271 / 0x03)
```

The authorization carries a `VAULT_KEY_USE` caveat (non-subdelegable). It is **custody-policy-
governed** (ADR-0011) — a custody op, not a routine session delegation. The SA address never
changes; rotating the KEK later re-runs this step with a new `kmsKeyRef`.

## 3. demo-mcp — verify + bind

```
POST /custody/vault-key/bind
{ owner, vaultId, kmsKeyRef, allowedResources, classificationCeiling, ops, expiresAt, authorization }
```

demo-mcp verifies the authorization end-to-end — the `VAULT_KEY_USE` caveat matches the KEK +
scope, the delegator is the owner SA, and the **owner SA actually signed it** (ERC-1271 via the
`UniversalSignatureValidator`) — then persists the `VaultKeyBinding` (migration `0008`). On a bad
signature or scope mismatch it returns `401 authorization_invalid` and stores nothing.

After binding, the person's vault is live: `get_pii` / `get_org_sensitive` / `get_profile` /
`get|set|list_vault_record` and the OAuth `/mcp` path all run the full chain — entitlement →
DecryptGrant/KAS (which **also** re-checks this vault-key authorization per op) → required audit
→ decrypt under the person's KEK.

## Revocation / rotation

- **Revoke:** set `revoked_at` on the binding row (the live-lookup index skips it) ⇒ the person's
  vault returns to fail-closed immediately.
- **Rotate the KEK:** provision a new key version (never destroy the old — old ciphertext must stay
  decryptable), then re-run steps 2–3 with the new `kmsKeyRef`. The SA address is unchanged.
