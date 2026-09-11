// THE PERSON'S AGENT, ASKED AS THEM — the only thing this Worker talks to. Each request to `/harness/ask` at the
// a2a origin carries an `A2A-Session` assertion (spec 372 S3c): signed by THIS Worker's key over the exact body,
// the method `harness.ask`, the audience and the moment, session-wrapped with the person's ask-as-me wire (person →
// this key, pinned to harness.ask). The receiver verifies the wire against the person on chain per request and
// spends the assertion once; the run then proceeds as the person. No bearer of theirs, no session of theirs.
import { wrapSessionSignature, type DelegationWireV1 } from '@agenticprimitives/a2a';
import { callerAssertionDigest, requestBodyHash, sessionAuthorizationHeader, STANDARD_SURFACE_SKILL, type CallerAssertionV1 } from '@agenticprimitives/a2a/standard';
import { sign as signRaw } from 'viem/accounts';
import type { Hex } from 'viem';

export interface PersonIdentity { agent: string; privateKey: Hex; wire: DelegationWireV1 }

export interface AskBody { addressee: string; message?: string; runRef?: string; supplied?: unknown[]; plan?: unknown; model?: string }

export async function askAsPerson(id: PersonIdentity, a2aOrigin: string, body: AskBody, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; reply: Record<string, unknown>; runRef?: string; hasProvenance?: unknown } | { ok: false; status: number; error: string }> {
  // `method` names the assertion's method (the receiver compares it to the body's); the route ignores the field.
  const raw = JSON.stringify({ method: STANDARD_SURFACE_SKILL, ...body });
  const base: Omit<CallerAssertionV1, 'signature'> = { agent: id.agent.toLowerCase(), method: STANDARD_SURFACE_SKILL, bodyHash: requestBodyHash(raw), issuedAt: Math.floor(Date.now() / 1000), audience: new URL(a2aOrigin).origin };
  const sig = await signRaw({ hash: callerAssertionDigest(base), privateKey: id.privateKey, to: 'hex' });
  const assertion: CallerAssertionV1 = { ...base, signature: wrapSessionSignature(id.wire, sig) };
  let res: Response;
  try {
    res = await fetchImpl(`${a2aOrigin}/harness/ask`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: sessionAuthorizationHeader(assertion) }, body: raw });
  } catch (e) { return { ok: false, status: 502, error: `the person's agent could not be reached: ${e instanceof Error ? e.message : String(e)}` }; }
  const out = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; reply?: Record<string, unknown>; runRef?: string; hasProvenance?: unknown } | null;
  if (!out) return { ok: false, status: res.status, error: `the person's agent answered ${res.status} with no JSON` };
  if (!res.ok || out.ok === false) return { ok: false, status: res.status, error: String(out.error ?? `the person's agent answered ${res.status}`) };
  return { ok: true, reply: out.reply ?? {}, ...(out.runRef ? { runRef: out.runRef } : {}), ...(out.hasProvenance ? { hasProvenance: out.hasProvenance } : {}) };
}
