// ACT-AS-ME (spec 397 §11) — the SECOND grant a client may hold, beside ask-as-me, and the only thing it adds: when
// an act already on the person's playbook parks `authority_required`, and one of her STANDING WIRES covers it — the
// capability, the window, and for a payment the payee, the asset and the cap — this Worker derives the mandate the
// run asked for from that wire (`deriveFromStanding`: a child bound to this run's intent, signed with the ACT key,
// presented as [child, standing]) and resumes the same run. Her agent verifies every link as it verifies a mandate
// she signed at her Home; the second-party obligation is discharged by her standing decision; the step runs.
//
// THE DOCTRINE, in one place:
//   - the ask-as-me wire still admits the ask (that proves WHO is asking); act wires are presented on the resume
//     call only — bound by the assertion's body hash, never in the bearer, never logged;
//   - the ACT key is a second secret: a stolen ASK key still cannot derive a mandate (the act wires name the act key);
//   - one wire per capability, one selector each, never A2A_ANY_SKILL; a wire that does not cover the step derives
//     nothing, and `grant_link` still works — an act with no matching wire still needs her signature;
//   - only a client REGISTERED to request scope `act` gets this; Claude's dynamic registration cannot.
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { deriveFromStanding, parkedNeedOf, standingFor, type StandingWireV1 } from '@agenticprimitives/delegation';

export const ACT_TEMPLATE = 'act-as-me' as const;
export const ACT_SCOPE = 'act' as const;

/** The act grant this Worker holds for a person: her standing wires, each one capability. Sealed at rest beside the ask wire. */
export interface ActGrantV1 { v: 1; client_id: string; standing: StandingWireV1[]; granted_at: number }

const listOf = (v: string | undefined): string[] => (v ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

/** A registration may hold scope `act` only when the OPERATOR allowed it: a registration that presented the act
 *  registration secret (`x-act-registration`), a client id named in `ACT_CLIENT_IDS`, or — for a host that registers
 *  itself afresh on every attempt (Meta Muse, 2026-10-01) — a registration whose EVERY redirect URI is in
 *  `ACT_REDIRECT_URIS`. The redirect URI is what an authorization code is sent to, so naming it names the party
 *  (plus PKCE binds the code to the requester). A dynamic registration with none of these — Claude's — cannot
 *  request it (`invalid_scope`). */
export function clientMayAct(env: { ACT_CLIENT_IDS?: string; ACT_REDIRECT_URIS?: string }, clientId: string, actFlag: boolean | undefined, redirectUris: readonly string[] = []): boolean {
  if (actFlag === true) return true;
  if (listOf(env.ACT_CLIENT_IDS).includes(clientId)) return true;
  const allowed = new Set(listOf(env.ACT_REDIRECT_URIS).map((u) => u.replace(/\/$/, '')));
  return allowed.size > 0 && redirectUris.length > 0 && redirectUris.every((u) => allowed.has(u.replace(/\/$/, '')));
}

export const requestsAct = (scope: readonly string[]): boolean => scope.includes(ACT_SCOPE);

/** The act key's address — the `delegate` every act wire must name (and the Home's `home-mcp-act` client registers). */
export function actKeyAddress(env: { HOME_MCP_ACT_KEY?: string }): string | null {
  return env.HOME_MCP_ACT_KEY ? privateKeyToAccount(env.HOME_MCP_ACT_KEY as Hex).address.toLowerCase() : null;
}

/** Accept the standing wires the Home returned: each must be the person's (or her treasury's — a payment wire's
 *  delegator is the treasury) and must name THIS Worker's act key. Anything else is refused by name. */
export function acceptStandingWires(env: { HOME_MCP_ACT_KEY?: string }, agent: string, wires: unknown): { ok: true; standing: StandingWireV1[] } | { ok: false; error: string } {
  const key = actKeyAddress(env);
  if (!key) return { ok: false, error: 'this Home MCP holds no act key (HOME_MCP_ACT_KEY) — scope act is not served here' };
  if (!Array.isArray(wires) || wires.length === 0) return { ok: false, error: 'the Home returned no act wires' };
  const out: StandingWireV1[] = [];
  for (const w of wires as StandingWireV1[]) {
    if (!w || w.v !== 1 || typeof w.capability !== 'string' || !w.wire || typeof w.ref !== 'string' || !w.requirement) return { ok: false, error: 'an act wire is malformed' };
    if (String(w.wire.delegate ?? '').toLowerCase() !== key) return { ok: false, error: `the act wire for ${w.capability} does not name this Home MCP's act key` };
    const delegator = String(w.wire.delegator ?? '').toLowerCase();
    const limits = (w.requirement.limits ?? {}) as Record<string, unknown>;
    // A capability wire is HERS; a payment wire is her TREASURY's (assets live only in treasuries) — the Home said
    // which treasury when it built it; what this Worker can check is that a non-payment wire is the person's own.
    if (w.capability !== 'treasury.payment.execute' && delegator !== agent.toLowerCase()) return { ok: false, error: `the act wire for ${w.capability} is not the connecting person's` };
    if (w.capability === 'treasury.payment.execute' && (!limits.payee || !limits.asset || !limits.maxAmount)) return { ok: false, error: 'a payment act wire must carry its payee, asset and cap' };
    out.push(w);
  }
  return { ok: true, standing: out };
}

/** What the person's agent said it needs, and the capability it named — from an `authority_required` reply. */
export interface Parked { runRef: string; capability: string; need: NonNullable<ReturnType<typeof parkedNeedOf>> }

export function parkedOf(reply: Record<string, unknown>, runRef: string): Parked | null {
  const need = parkedNeedOf(reply);
  const capability = typeof reply.capability === 'string' ? reply.capability : '';
  if (!need || !capability || !runRef) return null;
  return { runRef, capability, need };
}

export type ActDerivation = { ok: true; presented: Array<Record<string, unknown>>; childRef: Hex; parentRef: Hex; capability: string } | { ok: false; reason: string };

/** The chain for THIS parked step from her standing wires, signed with the act key — or why the run stays parked. */
export async function deriveForParked(env: { HOME_MCP_ACT_KEY?: string }, grant: ActGrantV1, parked: Parked): Promise<ActDerivation> {
  if (!env.HOME_MCP_ACT_KEY) return { ok: false, reason: 'no act key' };
  const s = standingFor(grant.standing, parked.need, parked.capability);
  if (!s) return { ok: false, reason: `no standing wire covers ${parked.capability} for ${parked.need.delegator}` };
  // The act key is an EOA delegator: the DelegationManager recovers an EOA's signature from the EIP-191 eth-signed
  // hash of the digest (`_validateSignature`), never the raw digest — so the child is signed as `signMessage({ raw })`,
  // the same form every key-held delegator in this estate uses (`custody-oidc.ts`).
  const account = privateKeyToAccount(env.HOME_MCP_ACT_KEY as Hex);
  const r = await deriveFromStanding(s, parked.need, async (digest) => account.signMessage({ message: { raw: digest } }));
  return r.ok ? { ...r, capability: parked.capability } : r;
}
