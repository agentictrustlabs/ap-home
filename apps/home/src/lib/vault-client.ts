// Per-agent MCP vault reads via a delegation (spec 247), from the person's home.
//
// To read an agent's vault you present a delegation whose DELEGATOR owns the data:
// the demo-a2a relayer ERC-1271-verifies it, opens a session, mints a token with
// `sub = the delegator`, and demo-mcp returns that owner's records (keyed by the
// recovered principal). All MCP access goes through demo-a2a (no direct MCP calls).
//
// On /you the person reads an organization they STEWARD via the stewardship
// delegation (delegator = org, delegate = person): the data owner is the org, so
// `requester` is the delegate (the person). Mirrors demo-jp's vault-client
// `vaultReadWithDelegation`; reads only (the home never writes the org's vault here).
import type { DelegationWire } from './delegation';
import { ensureCsrfToken, csrfHeaders } from '../csrf';

async function postVault(
  path: 'get' | 'list' | 'set',
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await ensureCsrfToken();
  const r = await fetch(`/a2a/mcp/vault/${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  if (!r.ok || !j || j.ok !== true) {
    throw new Error((j?.detail as string) ?? (j?.error as string) ?? `vault ${path} failed (HTTP ${r.status})`);
  }
  return j;
}

export interface VaultRecordRef {
  record_type: string;
  updated_at: string;
}

/** Enumerate the live record types in the DELEGATOR's vault (no payloads). */
export async function vaultListWithDelegation(d: DelegationWire): Promise<VaultRecordRef[]> {
  const j = await postVault('list', { delegation: d, requester: d.delegate });
  return (j.records ?? []) as VaultRecordRef[];
}

/** Read one record from the DELEGATOR's vault; `null` if absent or tombstoned. */
export async function vaultReadWithDelegation<T = unknown>(
  d: DelegationWire,
  recordType: string,
): Promise<T | null> {
  const j = await postVault('get', { delegation: d, requester: d.delegate, recordType });
  return (j.data ?? null) as T | null;
}

/** Upsert a record in the DELEGATOR's vault. `data === null` soft-deletes (tombstone).
 *  With the stewardship delegation (delegator = org) this is how a steward MANAGES the
 *  org's own data: the relayer mints a token with sub = org, so the write lands in the
 *  org's vault. No new signing — the already-signed delegation authorizes the write. */
export async function vaultWriteWithDelegation(
  d: DelegationWire,
  recordType: string,
  data: unknown,
): Promise<void> {
  await postVault('set', { delegation: d, requester: d.delegate, recordType, data });
}
