// ONE RECORD'S DATA, AS EVERY READER RECEIVES IT — the vault service's single read of an owner's record for its tools
// (`get_vault_record`, `get_vault_records`, `get_entitled_record`, the native ingress). Every record is returned as stored,
// except the Library index: `content.catalog` is assembled from its pages when the owner is paged (catalog-pages.ts) and
// expanded when it is stored compact (catalog-codec.ts), so the Home, the skills app, an older runtime and a member
// reading under an entitlement all get the same plain array. The pages are the catalog's storage, not separate records:
// a caller authorized for `vault:content.catalog` reads the catalog, whatever the pages are called.
//
// A field projection (an entitlement's `allowedFields`) applies to the ASSEMBLED value, never to the stored shape — a
// projection of the compact object would have dropped its `entries` and answered a member with `{}`.
import type { Vault } from '@agenticprimitives/vault';
import { projectFields } from '@agenticprimitives/vault';
import { CATALOG_RECORD } from './catalog-codec.js';
import { CATALOG_ROOT_RECORD, activeCatalogRoot, readCatalog } from './catalog-pages.js';
import { VAULT_RECORD_PREFIX } from './vault.js';

export async function readVaultRecordData(vault: Pick<Vault, 'read'>, owner: string, resource: string, fields?: string[]): Promise<unknown> {
  if (resource !== `${VAULT_RECORD_PREFIX}${CATALOG_RECORD}`) {
    const obj = await vault.read({ owner, resource, ...(fields ? { fields } : {}) });
    return obj?.data ?? null;
  }
  const one = async (recordType: string): Promise<unknown> => (await vault.read({ owner, resource: `${VAULT_RECORD_PREFIX}${recordType}` }))?.data ?? null;
  const data = await readCatalog(async (recordTypes) => Promise.all(recordTypes.map(one)));
  return projectFields(data ?? null, fields);
}

/** Is this owner's Library index paged? A whole-list write of the legacy record is then refused (`catalog_paged`). */
export async function catalogIsPaged(vault: Pick<Vault, 'read'>, owner: string): Promise<boolean> {
  return activeCatalogRoot((await vault.read({ owner, resource: `${VAULT_RECORD_PREFIX}${CATALOG_ROOT_RECORD}` }))?.data ?? null) !== null;
}
