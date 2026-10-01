// THE PERSON'S AGENT, ASKED AS THEM — the only thing this Worker talks to. Each request to `/harness/ask` at the
// a2a origin carries an `A2A-Session` assertion (spec 372 S3c): signed by THIS Worker's key over the exact body,
// the method `harness.ask`, the audience and the moment, session-wrapped with the person's ask-as-me wire (person →
// this key, pinned to harness.ask). The receiver verifies the wire against the person on chain per request and
// spends the assertion once; the run then proceeds as the person. No bearer of theirs, no session of theirs.
import { wrapSessionSignature, type DelegationWireV1 } from '@agenticprimitives/a2a';
import { callerAssertionDigest, requestBodyHash, sessionAuthorizationHeader, STANDARD_SURFACE_SKILL, type CallerAssertionV1 } from '@agenticprimitives/a2a/standard';
import { sign as signRaw } from 'viem/accounts';
import { hashDelegation, type Delegation } from '@agenticprimitives/delegation';
import type { Hex } from 'viem';

export interface PersonIdentity { agent: string; privateKey: Hex; wire: DelegationWireV1 }

/** Spec 410 §1.2 step 4 — what a refresh learns about the wire this Worker holds. */
export type WireRefresh =
  | { status: 'current' }
  | { status: 'superseded'; wire: DelegationWireV1; hash: string }
  | { status: 'gone' }
  | { status: 'unavailable'; error: string };

/**
 * THE WIRE REFRESH. Her agent refused the wire — but a credential ROTATION at her Home re-issues a key-signed wire
 * as an approved-digest one with the same terms, and the object this Worker holds is merely stale. Before ending
 * the connection, ask her agent for the head of the wire's lineage, signing the assertion DIRECTLY with this
 * Worker's key (the wire is what is in question, so it cannot wrap the signature). `superseded` carries the
 * object to hold now; `gone` means she struck it from the reviewed list, which is a revocation — the host
 * re-authorizes at her Home. Nothing here is authority: the wire returned was approved by her account on chain.
 */
export async function refreshWire(id: PersonIdentity, a2aOrigin: string, chain: { chainId: number; delegationManager: Hex }, fetchImpl: typeof fetch = fetch): Promise<WireRefresh> {
  const d: Delegation = { delegator: id.wire.delegator, delegate: id.wire.delegate, authority: id.wire.authority, caveats: id.wire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })), salt: BigInt(id.wire.salt), signature: id.wire.signature };
  const hash = hashDelegation(d, chain.chainId, chain.delegationManager);
  const nonce = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const raw = JSON.stringify({ method: 'wires/refresh', nonce, delegator: id.wire.delegator.toLowerCase(), hash });
  const base: Omit<CallerAssertionV1, 'signature'> = { agent: id.wire.delegate.toLowerCase(), method: 'wires/refresh', bodyHash: requestBodyHash(raw), issuedAt: Math.floor(Date.now() / 1000), audience: new URL(a2aOrigin).origin };
  const signature = await signRaw({ hash: callerAssertionDigest(base), privateKey: id.privateKey, to: 'hex' });
  let res: Response;
  try {
    res = await fetchImpl(`${a2aOrigin}/wires/refresh`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: sessionAuthorizationHeader({ ...base, signature }) }, body: raw });
  } catch (e) { return { status: 'unavailable', error: e instanceof Error ? e.message : String(e) }; }
  const out = (await res.json().catch(() => null)) as { ok?: boolean; status?: string; wire?: DelegationWireV1 | null; hash?: string; error?: string } | null;
  if (res.status === 410 || out?.status === 'gone') return { status: 'gone' };
  if (!res.ok || !out?.ok) return { status: 'unavailable', error: String(out?.error ?? `wires/refresh answered ${res.status}`) };
  if (out.status === 'superseded' && out.wire && out.hash) return { status: 'superseded', wire: out.wire, hash: out.hash };
  return { status: 'current' };
}

export interface AskBody { addressee: string; message?: string; runRef?: string; supplied?: unknown[]; plan?: unknown; model?: string; /** Spec 397 §11 — the chain derived from her act wire for a parked step, on the resume call only. */ presented?: unknown[]; /** Which client and template, for the door and the receipt. */ via?: { client: string; template: string } }

/** The wire itself was refused by her agent — revoked at her Home, or expired: the person must authorize again. */
export const isDelegationRefusal = (status: number, error: string): boolean => status === 401 && /app delegation|revoked|wire/i.test(error);

/** ONE signed call at the person's agent, as them: the ask surface's routes (`/harness/ask`, `/records`, `/runs`,
 *  `/progress`) under the same assertion + wire. The wire pins `harness.ask` — the act of asking; every route here
 *  is a read or a turn OF that act, never a different capability. */
export async function callAsPerson(id: PersonIdentity, a2aOrigin: string, path: string, body: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; body: Record<string, unknown>; status: number } | { ok: false; status: number; error: string; body?: Record<string, unknown> }> {
  // `method` names the assertion's method (the receiver compares it to the body's); the route ignores the field.
  // `nonce` makes every body distinct: the assertion is spent once per digest, and two identical bodies in the same
  // second (a record read right after a run tool) would otherwise be one digest — the second refused as a replay.
  const nonce = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const raw = JSON.stringify({ method: STANDARD_SURFACE_SKILL, nonce, ...body });
  const base: Omit<CallerAssertionV1, 'signature'> = { agent: id.agent.toLowerCase(), method: STANDARD_SURFACE_SKILL, bodyHash: requestBodyHash(raw), issuedAt: Math.floor(Date.now() / 1000), audience: new URL(a2aOrigin).origin };
  const sig = await signRaw({ hash: callerAssertionDigest(base), privateKey: id.privateKey, to: 'hex' });
  const assertion: CallerAssertionV1 = { ...base, signature: wrapSessionSignature(id.wire, sig) };
  let res: Response;
  try {
    res = await fetchImpl(`${a2aOrigin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: sessionAuthorizationHeader(assertion) }, body: raw });
  } catch (e) { return { ok: false, status: 502, error: `the person's agent could not be reached: ${e instanceof Error ? e.message : String(e)}` }; }
  const out = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!out) return { ok: false, status: res.status, error: `the person's agent answered ${res.status} with no JSON` };
  if (!res.ok || out.ok === false) return { ok: false, status: res.status, error: String(out.error ?? `the person's agent answered ${res.status}`), body: out };
  return { ok: true, body: out, status: res.status };
}

export async function askAsPerson(id: PersonIdentity, a2aOrigin: string, body: AskBody, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; reply: Record<string, unknown>; runRef?: string; hasProvenance?: unknown } | { ok: false; status: number; error: string }> {
  const r = await callAsPerson(id, a2aOrigin, '/harness/ask', body as unknown as Record<string, unknown>, fetchImpl);
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  const out = r.body as { reply?: Record<string, unknown>; runRef?: string; hasProvenance?: unknown };
  return { ok: true, reply: out.reply ?? {}, ...(out.runRef ? { runRef: out.runRef } : {}), ...(out.hasProvenance ? { hasProvenance: out.hasProvenance } : {}) };
}

/** The agent's own progress lines for a run (spec 370 P2), long-polled as the person. */
export async function progressAsPerson(id: PersonIdentity, a2aOrigin: string, runRef: string, after: number, fetchImpl: typeof fetch = fetch): Promise<{ lines: Array<{ seq: number; said: string; stepRef?: string; terminal?: boolean }>; terminal: boolean; known: boolean }> {
  const r = await callAsPerson(id, a2aOrigin, '/harness/progress', { addressee: id.agent, runRef, after, wait: 3000 }, fetchImpl);
  if (!r.ok) return { lines: [], terminal: false, known: false };
  const b = r.body as { lines?: Array<{ seq: number; said: string; stepRef?: string; terminal?: boolean }>; terminal?: boolean; known?: boolean };
  return { lines: b.lines ?? [], terminal: !!b.terminal, known: !!b.known };
}
