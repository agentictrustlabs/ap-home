// Control-plane projections (spec 310 W4). Maps this app's existing surfaces —
// the delegation grants a person issued (spec 246/247) and the spec 275
// managed-agent tree — onto the PORTABLE @agenticprimitives/home contracts,
// and emits HomeControlEventV1 rows to the timeline. Pure mapping + fetch:
// the authority stays in the delegation package / on-chain; a projection row
// is a view, never a grant.
import { hashDelegation } from '@agenticprimitives/delegation';
import type {
  ConnectedAppGrantV1,
  HomeControlEventV1,
  ManagedAgentEntryV1,
} from '@agenticprimitives/home';
import type { Address, Hex } from '@agenticprimitives/types';
import type { DelegationWire } from '../lib/delegation';
import { CHAIN_ID, CONTRACTS } from '../lib/chain';
import { homeCaip10 } from './manifest';

/** Parse the TimestampEnforcer window out of a wire delegation's caveats. */
function timestampWindow(wire: DelegationWire): { validAfter?: number; validUntil?: number } {
  for (const c of wire.caveats) {
    if (c.enforcer.toLowerCase() !== CONTRACTS.timestampEnforcer.toLowerCase()) continue;
    try {
      const b = c.terms.startsWith('0x') ? c.terms.slice(2) : c.terms;
      return { validAfter: parseInt(b.slice(0, 64), 16), validUntil: parseInt(b.slice(64, 128), 16) };
    } catch {
      return {};
    }
  }
  return {};
}

/** The canonical EIP-712 digest of the wire delegation — the AuthorityRef hash. */
export function delegationRefHash(wire: DelegationWire): Hex {
  return hashDelegation(
    {
      delegator: wire.delegator,
      delegate: wire.delegate,
      authority: wire.authority,
      caveats: wire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })),
      salt: BigInt(wire.salt),
      signature: wire.signature,
    },
    CHAIN_ID,
    CONTRACTS.delegationManager as Address,
  );
}

/** Project one issued delegation onto the portable connected-app grant row.
 *  `scope` is the app-level grant kind (site / membership / stewardship). */
export function toConnectedAppGrant(scope: string, wire: DelegationWire, revoked = false): ConnectedAppGrantV1 {
  const { validAfter, validUntil } = timestampWindow(wire);
  const now = Math.floor(Date.now() / 1000);
  return {
    app: wire.delegate,
    grantRef: { kind: 'delegation', hash: delegationRefHash(wire) },
    scope: [scope],
    grantedAt: new Date((validAfter ?? 0) * 1000).toISOString(),
    expiresAt: validUntil !== undefined ? new Date(validUntil * 1000).toISOString() : undefined,
    status: revoked ? 'revoked' : validUntil !== undefined && now >= validUntil ? 'expired' : 'active',
  };
}

const AGENT_TYPE: Record<string, ManagedAgentEntryV1['agentType']> = {
  org: 'organization',
  team: 'organization',
  'person-treasury': 'treasury',
  'org-treasury': 'treasury',
};

/** Project a spec 275 managed agent (created + custodied by the member's ROOT
 *  credential) onto the portable console row. */
export function toManagedAgentEntry(a: { agent: string; kind: string; parent: string }, person: string): ManagedAgentEntryV1 {
  const self = a.agent.toLowerCase() === person.toLowerCase();
  return {
    agent: homeCaip10(a.agent as Address),
    agentType: self ? 'person' : (AGENT_TYPE[a.kind] ?? 'service'),
    relationship: self ? 'self' : AGENT_TYPE[a.kind] === 'organization' ? 'administered_by_subject' : 'owned_by_subject',
    // The member's ROOT credential custodies every agent in the spec 275 tree.
    controlGrade: 'custody',
    status: 'active',
    supportedActions: [],
  };
}

/** Emit a control-plane event to the timeline (fire-and-forget from UI paths —
 *  the SECURITY audit row is written server-side; this is the projection). */
export async function emitControlEvent(
  token: string,
  eventType: HomeControlEventV1['eventType'],
  refs: HomeControlEventV1['refs'] = [],
): Promise<void> {
  try {
    await fetch('/connect/control-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ eventType, refs }),
    });
  } catch {
    /* the timeline is a projection; the on-chain / audit record is canonical */
  }
}

export async function listControlEvents(token: string): Promise<HomeControlEventV1[]> {
  const res = await fetch('/connect/control-events', { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const body = (await res.json()) as { events?: HomeControlEventV1[] };
  return body.events ?? [];
}
