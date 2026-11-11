// "Let <name>.svc read works it is granted" — the person, as the CUSTODIAN of a service agent they chartered, signs that
// agent's A2A signing wire for `library.granted.read`, and the agent's InteractionsDO stores it (`signing.serviceWire`).
//
// ONE WIRE PER RECEIVING AGENT (spec 445 RUN-9): the wire names the PUBLISHER it is presented at (allowedTargets), so the person says
// which publisher, and each is signed, kept and revoked on its own.
//
// The same ceremony as the org routing-enable (org-agent.tsx → issueOrgConsultRoutingDelegation → consult.routingEnable),
// end to end, with three differences that are the whole point:
//   · the principal is a SERVICE, and the admission is CUSTODY (`canGrantAs` — isCustodian / hasPasskey on the agent SA),
//     not stewardship: only the credential that custodies the agent can produce a signature its ERC-1271 accepts;
//   · the wire names exactly ONE method (library.granted.read), so it can sign nothing but a granted read;
//   · it is stored under its own key, so it never replaces an org's consult wire.
//
// REVOCATION is on chain, like any delegation: `revokeWorkspaceReadWire` has the agent SA execute
// `DelegationManager.revokeDelegationByOwner(wire)` (signed by the same custodian credential), after which every publisher's
// gate refuses a message under it (`isRevoked` per message); then the DO's stored copy is cleared (the DO clears only a
// wire the chain says is revoked or expired).
//
// Every seam is injected so the flow is testable without a browser; `workspaceReadDeps` binds the real ones.
import type { Address, Hex } from '@agenticprimitives/types';
import { issueServiceLibraryReadWire, toWire, type DelegationWire } from '../lib/delegation';
import { workspaceReadAdmission, type WorkspaceReadError } from '../lib/workspace-read-ceremony';

export interface WorkspaceReadStatus {
  wirePresent: boolean;
  sessionKey: string | null;
  hash?: string;
  enabledAt?: string;
  validUntil?: number | null;
  wire?: DelegationWire;
  /** Every publisher this agent holds a wire for (RUN-9: one wire per receiving agent). */
  wires?: Array<{ target: string | null; hash: string; enabledAt: string; validUntil: number | null }>;
}

export interface WorkspaceReadDeps {
  /** One `/connect/channels` call (the proxy to the agent's InteractionsDO), authenticated with the Home session. */
  channels(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Can the signed-in credential grant as `agent`? (`canGrantAs(agent, connectedCredential(…))`.) */
  canGrantAs(agent: Address): Promise<boolean>;
  /** The custodian credential's signer for `agent` (`signHashFor(via, agent, { token })`). */
  signAs(agent: Address): Promise<(hash: Hex) => Promise<Hex>>;
  /** On-chain revoke as the delegator (`revokeGrantedDelegation`). */
  revokeOnChain(wire: DelegationWire, sign: (hash: Hex) => Promise<Hex>): Promise<{ ok: true; txHash?: Hex } | { ok: false; error: string }>;
}

/** The agent's signing-wire status; with `publisher`, `wirePresent` / `wire` answer for THAT receiving agent's wire. */
export async function readWorkspaceReadStatus(deps: Pick<WorkspaceReadDeps, 'channels'>, agent: Address, publisher?: Address): Promise<WorkspaceReadStatus> {
  const r = await deps.channels({ action: 'signingWireStatus', communityId: agent.toLowerCase(), ...(publisher ? { target: publisher.toLowerCase() } : {}) });
  if (r.status >= 400 || r.body.ok !== true) throw new Error(String(r.body.error ?? `the signing-wire status could not be read (${r.status})`));
  return r.body as unknown as WorkspaceReadStatus;
}

export type WorkspaceReadOutcome =
  | { ok: true; hash: string; validUntil: number | null }
  | { ok: false; error: WorkspaceReadError; said: string };

/** THE CEREMONY. Admission first (class + custody, in words), then mint → custodian-sign → the DO verifies + stores. */
export async function enableWorkspaceReadWire(
  deps: WorkspaceReadDeps,
  input: { agent: Address; agentLabel: string; isService: boolean; /** The PUBLISHER's agent the wire is presented at — its allowedTargets (RUN-9: one wire per receiving agent). */ publisher: Address },
): Promise<WorkspaceReadOutcome> {
  const agent = input.agent.toLowerCase() as Address;
  const publisher = input.publisher.toLowerCase() as Address;
  if (!/^0x[0-9a-f]{40}$/.test(publisher) || publisher === agent) return { ok: false, error: 'failed', said: 'name the publisher\'s agent (a 0x address, another agent than this one) — the wire is a credential only at the agent it names' };
  const custodian = input.isService ? await deps.canGrantAs(agent).catch(() => false) : false;
  const adm = workspaceReadAdmission({ agentLabel: input.agentLabel, isService: input.isService, custodian });
  if (!adm.ok) return adm;
  let st: WorkspaceReadStatus;
  try { st = await readWorkspaceReadStatus(deps, agent); } catch (e) { return { ok: false, error: 'failed', said: e instanceof Error ? e.message : String(e) }; }
  if (!st.sessionKey) return { ok: false, error: 'failed', said: 'this deployment has no interactions-session key provisioned, so no agent can sign here yet' };
  let wire: DelegationWire;
  try {
    wire = toWire(await issueServiceLibraryReadWire(agent, st.sessionKey as Address, publisher, await deps.signAs(agent)));
  } catch (e) {
    return { ok: false, error: 'denied', said: `the signature was not given (${e instanceof Error ? e.message : String(e)})` };
  }
  const r = await deps.channels({ action: 'signingWireEnable', communityId: agent, target: publisher, delegation: wire });
  if (r.status >= 400 || r.body.ok !== true) {
    const said = String(r.body.error ?? `the agent did not store the wire (${r.status})`);
    return { ok: false, error: r.status === 403 && /does not verify against/.test(said) ? 'not_custodian' : 'failed', said };
  }
  return { ok: true, hash: String(r.body.hash), validUntil: typeof r.body.validUntil === 'number' ? r.body.validUntil : null };
}

/** REVOKE: on chain first (the authority kill at every publisher's gate), then the DO's copy (which it clears only after). */
export async function revokeWorkspaceReadWire(deps: WorkspaceReadDeps, agent: Address, publisher: Address): Promise<{ ok: true; txHash?: Hex } | { ok: false; error: string }> {
  const a = agent.toLowerCase() as Address;
  const st = await readWorkspaceReadStatus(deps, a, publisher);
  if (!st.wirePresent || !st.wire) return { ok: true };
  if (!(await deps.canGrantAs(a).catch(() => false))) return { ok: false, error: 'only the credential that custodies this agent can revoke its signing wire' };
  const rev = await deps.revokeOnChain(st.wire, await deps.signAs(a));
  if (!rev.ok) return rev;
  const c = await deps.channels({ action: 'signingWireClear', communityId: a, target: publisher.toLowerCase() });
  if (c.status >= 400 || c.body.ok !== true) return { ok: false, error: `revoked on chain${rev.txHash ? ` (${rev.txHash})` : ''}, but the agent's stored copy was not cleared yet: ${String(c.body.error ?? c.status)}` };
  return rev;
}

/** The real seams, for a signed-in Home page. Imported lazily so this module stays testable without a browser. */
export async function workspaceReadDeps(o: { token: string; via: string | undefined; credential: string | undefined; person: Address }): Promise<WorkspaceReadDeps> {
  const [{ resolveVia, signHashFor }, { canGrantAs }, { connectedCredential }, { revokeGrantedDelegation }] = await Promise.all([
    import('./onboarding'), import('./ask'), import('../components/portal/ask/credential'), import('../connect-client'),
  ]);
  const via = resolveVia(o.credential, o.via);
  return {
    async channels(body) {
      const r = await fetch('/connect/channels', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.token}` }, body: JSON.stringify(body) });
      return { status: r.status, body: ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
    },
    async canGrantAs(agent) { return canGrantAs(agent, await connectedCredential(via, o.person, o.token)); },
    signAs: (agent) => signHashFor(via, agent, { token: o.token }),
    revokeOnChain: (wire, sign) => revokeGrantedDelegation(wire, sign),
  };
}
