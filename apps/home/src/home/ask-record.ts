// FINISHING WHAT THE ASK STARTED — the private half of creating an agent.
//
// A created agent has two records, and only one of them is on chain. The chain has the SA, its typed name,
// its declared type and the stewardship grant it approved at birth; the person's own VAULT has the private
// link that says "this agent is mine" (ADR-0025: person↔org links are private vault credentials, never
// on-chain edges). The workspace switcher reads the vault, so an agent created without that record exists,
// resolves, and is custodied by you — and is invisible in your own home.
//
// That is exactly what happened the first time a team was chartered through the Ask (2026-09-03,
// `nathan.team`): the ceremony ended at the chain because the a2a cannot write a person's private vault
// and nothing on the surface finished the job. The Home's own button always did this final step; the Ask
// does it now too, with the SAME record shape — one tree, whichever way an agent was made.
import { buildRelatedAgentCredential, relatedAgentProofHash } from '@agenticprimitives/related-agents';
import type { Address } from '@agenticprimitives/types';
import { CHAIN_ID } from '../lib/chain';
import { invalidateRelatedOrgs } from '../connect-client';
import { requestReindex } from '../lib/reindex';
import type { DelegationWire } from '../lib/delegation';

/** What the harness returns when a `done` reply created an agent. */
export interface CreatedAgent {
  agent: Address;
  name: string;
  kind: string;
  parent: Address;
  person: Address;
  stewardshipDelegation?: DelegationWire;
  alreadyCreated?: boolean;
}

/** An invitation the harness produced: a signed org → invitee access grant that must be STORED in the
 *  organization's vault, or the invitee finds nothing when they join. */
export interface IssuedInvitation {
  org: Address;
  invitee: Address;
  memberAccessDelegation: DelegationWire;
  invited: true;
}

export function invitationOf(result: unknown): IssuedInvitation | null {
  const r = result as Partial<IssuedInvitation> | null;
  if (!r || typeof r !== 'object' || r.invited !== true) return null;
  return r.org && r.invitee && r.memberAccessDelegation ? (r as IssuedInvitation) : null;
}

/**
 * Store an invitation in the organization's vault — the private half, the same route the invite panel
 * posts to (`/connect/org-invite/agent`, steward-gated server-side). The a2a holds no delegation to that
 * vault and must not: it produced the signed grant, and the grant is what proves the invitation.
 */
export async function recordInvitation(inv: IssuedInvitation, sessionToken: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch('/connect/org-invite/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ org: inv.org.toLowerCase(), agent: inv.invitee.toLowerCase(), memberAccessDelegation: inv.memberAccessDelegation }),
  }).catch((e: unknown) => ({ ok: false, status: 0, json: async () => ({ error: String(e) }) }) as unknown as Response);
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: b.error ?? `HTTP ${res.status}` };
  }
  return { ok: true };
}

/** Is this `done` result an agent that needs recording? */
export function createdAgentOf(result: unknown): CreatedAgent | null {
  const r = result as Partial<CreatedAgent> | null;
  if (!r || typeof r !== 'object') return null;
  if (!r.agent || !r.parent || !r.person || !r.kind) return null;
  return r as CreatedAgent;
}

/**
 * Record a created agent in the asker's private tree, exactly as the Home's create ceremony does: the
 * related-agent credential (unsigned — the proof hash anchors integrity and the write happens inside this
 * authenticated session), the stewardship grant the agent approved at birth, then invalidate the cached
 * list so the switcher shows it now rather than after a reload.
 *
 * Best-effort by design and NOT silent: the agent is already real, so a failed vault write must never read
 * as a failed creation — it is reported as what it is, a link that did not save, with the agent named.
 */
export async function recordCreatedAgent(created: CreatedAgent, sessionToken: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const credential = buildRelatedAgentCredential({
    holder: created.person,
    relatedAgent: created.agent,
    purpose: created.kind,
    requestedBy: '',
    issuerCaip10: `eip155:${CHAIN_ID}:${created.person}`,
    body: { agentName: created.name },
    validFrom: new Date().toISOString(),
  });
  const res = await fetch('/connect/related-orgs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({
      person: created.person,
      orgAgent: created.agent,
      orgName: created.name,
      purpose: created.kind,
      kind: created.kind,
      parent: created.parent,
      ...(created.stewardshipDelegation ? { stewardshipDelegation: created.stewardshipDelegation } : {}),
      proofHash: relatedAgentProofHash(credential),
    }),
  }).catch((e: unknown) => ({ ok: false, status: 0, json: async () => ({ error: String(e) }) }) as unknown as Response);
  invalidateRelatedOrgs();      // this write changed the tree — the shared read must not serve the old payload
  requestReindex([created.agent]); // public, on-chain-derived: the new agent appears in discovery (ADR-0040)
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: b.error ?? `HTTP ${res.status}` };
  }
  return { ok: true };
}
