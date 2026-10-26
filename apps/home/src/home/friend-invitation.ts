// YOUR HALF OF A FRIENDSHIP, SIGNED WHEN THE INVITATION GOES OUT (spec 401 C1; the runtime's friend-invitations.ts).
// An email invitation names an address, not an agent, so your usual grant to the friend cannot be signed yet. You sign
// one grant to your own agent instead, for this invitation only; when they accept, your agent hands it on to them and
// records your half — you are friends without a second step.
import type { Hex } from '@agenticprimitives/types';
import type { SignHash } from '../connect-client';

export interface SentInvitation { token: string; email: string; expiresAt: number; acceptedBy?: string | null }

/** One of the person's own sent invitations, by its token — the Home's list is the only place its email is kept. */
export async function sentInvitation(session: { token: string }, token: string): Promise<SentInvitation | null> {
  const r = await fetch('/connect/friend-invite/email', { headers: { authorization: `Bearer ${session.token}` } });
  const d = (await r.json().catch(() => ({}))) as { ok?: boolean; sent?: SentInvitation[] };
  return d.sent?.find((s) => s.token === token) ?? null;
}

/** Ask your agent for the grant, sign it, and have your agent keep it beside the invitation. */
export async function signInvitationHalf(input: { session: { token: string }; token: string; expiresAt: number; signHash: SignHash }): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${input.session.token}` };
  const call = async (step: 'prepare' | 'offer', body: Record<string, unknown>) => {
    const r = await fetch(`/a2a/friend-invitation/${step}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    return (await r.json().catch(() => ({ ok: false, error: `your agent did not answer (${r.status})` }))) as { ok?: boolean; error?: string; digest?: Hex };
  };
  const prepared = await call('prepare', { token: input.token, expiresAt: input.expiresAt });
  if (!prepared.ok || !prepared.digest) return { ok: false, error: prepared.error ?? 'your agent could not prepare your half' };
  let signature: Hex;
  try { signature = await input.signHash(prepared.digest); } catch (e) { return { ok: false, error: `it was not signed: ${e instanceof Error ? e.message : String(e)}` }; }
  const kept = await call('offer', { token: input.token, expiresAt: input.expiresAt, signature, type: 'friend' });
  return kept.ok ? { ok: true } : { ok: false, error: kept.error ?? 'your agent could not keep your half' };
}
