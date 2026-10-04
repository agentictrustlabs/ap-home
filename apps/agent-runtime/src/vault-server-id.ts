// THE VAULT SERVER ID — the `server` every record-scope grant this runtime issues names, and the id the vault
// checks a grant against (`apps/vault/src/vault-key.ts` `vaultServerId`). A DEPLOYMENT's name for its vault
// (`VAULT_SERVER_ID` in wrangler vars, the same value on the vault and on the Home): a second deployment on the
// same chain names its own, so a grant made to one estate's vault never satisfies another's. Unset ⇒ `demo-mcp`,
// the id Ring 0's estates were provisioned under — Ring-0 developers see no change (spec 399 §0.1).
export const DEFAULT_VAULT_SERVER_ID = 'demo-mcp';
export function vaultServerId(env: { VAULT_SERVER_ID?: string }): string {
  return (env.VAULT_SERVER_ID ?? '').trim() || DEFAULT_VAULT_SERVER_ID;
}
