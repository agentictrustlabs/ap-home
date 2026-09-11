// Spec 397 W4 — the apps a person authorized with THEIR OWN wire (the Home MCP's ask-as-me), read from the Home and
// revoked on chain from here. The chain is the record; the Home keeps a pointer so the row can be shown.
import type { DelegationWire } from './delegation';

export interface AppGrant { clientId: string; appName: string; template: string; delegate: string; delegation: DelegationWire; issuedAt: number; validUntil: number | null }

export async function listAppGrants(token: string): Promise<AppGrant[]> {
  const r = await fetch('/connect/app-grants', { headers: { authorization: `Bearer ${token}` } });
  const b = (await r.json().catch(() => ({}))) as { grants?: AppGrant[] };
  return b.grants ?? [];
}

export async function forgetAppGrant(token: string, clientId: string): Promise<void> {
  await fetch('/connect/app-grants', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ clientId, revoked: true }) });
}
