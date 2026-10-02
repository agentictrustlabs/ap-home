// THE GOVERNOR OF A WORKSPACE — the owner's rule, 2026-10-02 (`packages/ontology/tbox/org.ttl` §2, `core.ttl`).
//
// A `<label>.workspace` Smart Agent is a SERVICE (`ap:WorkspaceAgent ⊑ ap:ServiceAgent`, `aporg:coordinatedBy`)
// that coordinates a workspace. It is NOT an organization and CANNOT have members. Every workspace that needs
// membership has an accompanying ORGANIZATION that GOVERNS it (`aporg:Workspace aporg:governedBy <org>`), and
// membership — `aporg:OrganizationMembership`, the `org.membership:member:<sa>` records with their role
// assignments — lives on the GOVERNING ORGANIZATION. Stewardship is a different situation; a relationship
// credential grants nothing.
//
// THE PAIRING is two records the ceremonies here write, and the agent runtime reads (its own
// `workspace-governor.ts` resolves a workspace scope to its governor from the pointer): the WORKSPACE agent's
// vault holds `workspace.governor` = `{ governedBy, coordinatedBy }`; the ORGANIZATION's vault holds the mirror
// `workspace:<ws sa>`, the `aporg:Workspace` entity. A workspace with NO pointer is a LEGACY one that still holds
// its own membership records; every ceremony keeps today's behaviour for it and says so once in the console.
//
// This module is the Home's CLIENT side of the rule: the record shapes, how a ceremony finds a workspace's
// governor, and the organization's half of the has-member credential (spec 410 §8) a join countersigns. The
// server's guard that refuses membership on a workspace is `server/lib/workspace-governor.ts`.
//
// DEMO-SSO-NEXT ADAPTATION (2026-10-02 port from apps/home): the credential digest / canonicalization is
// imported from `@agenticprimitives/agent-relationships` (a workspace dep here, so no re-vendoring), and the
// offer shape is the app's own `RelationshipOfferV1`. The countersignature door is `countersignRelationship`
// in `./org-membership`, which `recordOrgMembership` already drives for a join.
import type { Address } from '@agenticprimitives/types';
import { relationshipCredentialDigest, termsDigestOf, type RelationshipCredentialBodyV1 } from '@agenticprimitives/agent-relationships';
import type { Hex } from 'viem';
import { CHAIN_ID } from './chain';
import { vaultReadWithDelegation, vaultWriteWithDelegation } from './vault-client';
import type { DelegationWire } from './delegation';
import type { RelationshipOfferV1 } from '../home/ask-record';

export { termsDigestOf, relationshipCredentialDigest };
export type { RelationshipOfferV1 };

/** The pointer a governed workspace's agent keeps in its OWN vault. One record, one read. */
export const WORKSPACE_GOVERNOR_RECORD = 'workspace.governor';

/** The `aporg:Workspace` entity, in the GOVERNOR's vault, keyed by the agent that coordinates it. */
export const workspaceRecordKey = (ws: Address | string): string => `workspace:${ws.toLowerCase()}`;

export interface WorkspaceGovernorPointer {
  governedBy: Address;
  coordinatedBy: Address;
}

/** The `aporg:Workspace` record as the organization keeps it. `governedBy` is the organization itself: the record
 *  is readable on its own, by anybody holding the organization's vault, without knowing which vault it came from. */
export interface WorkspaceRecord extends WorkspaceGovernorPointer {
  type: 'aporg:Workspace';
  label: string;
  purpose: string;
  createdAt: string;
}

export function workspaceRecordOf(input: { governor: Address; workspace: Address; label: string; purpose: string; now?: Date }): WorkspaceRecord {
  return {
    type: 'aporg:Workspace',
    governedBy: input.governor.toLowerCase() as Address,
    coordinatedBy: input.workspace.toLowerCase() as Address,
    label: input.label,
    purpose: input.purpose,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

export function governorPointerOf(input: { governor: Address; workspace: Address }): WorkspaceGovernorPointer {
  return { governedBy: input.governor.toLowerCase() as Address, coordinatedBy: input.workspace.toLowerCase() as Address };
}

/** Pure: the governing organization a `workspace.governor` record names, or null for no pointer / a malformed one —
 *  treated exactly like no pointer, never as a governor at address zero. The same reading the runtime makes. */
export function governorOf(doc: unknown): Address | null {
  if (!doc || typeof doc !== 'object') return null;
  const g = (doc as { governedBy?: unknown }).governedBy;
  const addr = typeof g === 'string' ? g.toLowerCase() : '';
  return /^0x[0-9a-f]{40}$/.test(addr) ? (addr as Address) : null;
}

/**
 * WRITE THE PAIR. Both records, each under the wire that may write that vault: the organization's stewardship
 * wire (org → custodian) for the entity, the workspace's (ws → custodian) for the pointer. The pointer is written
 * LAST, because it is the one every reader keys on: a workspace whose pointer landed but whose entity did not is
 * still correctly governed (the entity is the organization's mirror), while the reverse would be a workspace the
 * organization lists but every roster read still treats as legacy.
 */
export async function writeGovernancePair(input: {
  orgStewardship: DelegationWire;
  wsStewardship: DelegationWire;
  governor: Address;
  workspace: Address;
  label: string;
  purpose: string;
}): Promise<void> {
  await vaultWriteWithDelegation(input.orgStewardship, workspaceRecordKey(input.workspace), workspaceRecordOf(input));
  await vaultWriteWithDelegation(input.wsStewardship, WORKSPACE_GOVERNOR_RECORD, governorPointerOf(input));
}

/** One row of `/connect/related-orgs`, the fields this module reads. */
export interface RelatedRow {
  orgAgent?: string;
  orgName?: string;
  kind?: string;
  purpose?: string;
  parent?: string;
  relationship?: string;
  stewardshipDelegation?: unknown;
  /** The governor the link was written with (create, join, or the migration). */
  governor?: string;
}

export interface ResolvedGovernor {
  governor: Address;
  governorName: string;
  /** The custodian's org → person stewardship wire over the governor, when their links hold one. */
  governorStewardship: DelegationWire | null;
}

const ORG_CLASS = new Set(['org', 'team', 'circle', 'church', 'household', 'organization']);
const isAddr = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);

/**
 * Pure: the governor the PERSON'S OWN LINKS name for a workspace, or null when they name none.
 *
 * Two readings, in order. The link's `governor` is what a ceremony wrote and is believed as written. Failing that,
 * the link's `parent` is the governor when it is an organization-class agent the person also links — "chartered
 * under" is readable as the parent on a link (`ap:charteredUnder`), and a workspace hangs under its governor. A
 * parent that is the person themselves, or an agent the links do not know, is not a governor.
 */
export function governorFromRows(rows: readonly RelatedRow[], workspace: Address | string, person: Address | string): ResolvedGovernor | null {
  const ws = workspace.toString().toLowerCase();
  const me = person.toString().toLowerCase();
  const row = rows.find((r) => (r.orgAgent ?? '').toLowerCase() === ws);
  if (!row) return null;
  const candidate = isAddr(row.governor) ? row.governor.toLowerCase() : isAddr(row.parent) && row.parent.toLowerCase() !== me ? row.parent.toLowerCase() : '';
  if (!candidate) return null;
  const org = rows.find((r) => (r.orgAgent ?? '').toLowerCase() === candidate);
  // A `parent` is only a governor when the links say that parent is an organization; a written `governor` is.
  if (!row.governor && !(org && ORG_CLASS.has((org.kind ?? 'org').toLowerCase()))) return null;
  return {
    governor: candidate as Address,
    governorName: org?.orgName ?? '',
    governorStewardship: org && org.relationship !== 'member' && org.stewardshipDelegation ? (org.stewardshipDelegation as DelegationWire) : null,
  };
}

/**
 * The governor of a workspace, as a ceremony needs it: the person's links first (no vault read), then the
 * pointer in the workspace's own vault over the person's stewardship wire. Null is the LEGACY answer — the
 * workspace holds its own membership and the caller keeps today's behaviour — and it is logged once per
 * workspace so a legacy club is a known thing in the console rather than a silent branch.
 */
export async function resolveWorkspaceGovernor(token: string, workspace: Address, person: Address): Promise<ResolvedGovernor | null> {
  const r = await fetch('/connect/related-orgs', { headers: { authorization: `Bearer ${token}` } });
  const body = (await r.json().catch(() => ({}))) as { orgs?: RelatedRow[] };
  const rows = body.orgs ?? [];
  const fromRows = governorFromRows(rows, workspace, person);
  if (fromRows) return fromRows;
  const row = rows.find((x) => (x.orgAgent ?? '').toLowerCase() === workspace.toLowerCase());
  const wire = row?.stewardshipDelegation as DelegationWire | undefined;
  if (wire) {
    const governor = governorOf(await vaultReadWithDelegation(wire, WORKSPACE_GOVERNOR_RECORD).catch(() => null));
    if (governor && governor !== workspace.toLowerCase()) {
      const org = rows.find((x) => (x.orgAgent ?? '').toLowerCase() === governor);
      return { governor, governorName: org?.orgName ?? '', governorStewardship: org && org.relationship !== 'member' && org.stewardshipDelegation ? (org.stewardshipDelegation as DelegationWire) : null };
    }
  }
  noteLegacy(workspace);
  return null;
}

const legacyNoted = new Set<string>();
function noteLegacy(workspace: Address): void {
  const key = workspace.toLowerCase();
  if (legacyNoted.has(key)) return;
  legacyNoted.add(key);
  console.info(`[workspace-governor] ${key} has no governing organization (a workspace chartered before 2026-10-02) — its membership stays on the workspace agent until \`scripts/workspace-governor.mts\` is run for it`);
}

// ── The organization's half of the has-member credential (spec 410 §8) ───────────────────────────────────
//
// The digest is `@agenticprimitives/agent-relationships`' (RFC 8785 over the body, the terms by digest), so the
// a2a worker's `/relationships/credential/accept` — which recomputes it — accepts what is signed here. The join
// countersigns through `countersignRelationship` (`./org-membership`), which `recordOrgMembership` drives.

/** THE ORGANIZATION'S OFFER of a has-member credential: its half, signed by its custody (ERC-1271 through the
 *  organization's account — `signAsObject` is `signHashFor(via, org, auth)`). The member countersigns at join. */
export async function offerRelationshipCredential(input: {
  kind: RelationshipOfferV1['kind'];
  subject: Address;
  object: Address;
  terms: Record<string, unknown>;
  signAsObject: (digest: Hex) => Promise<Hex>;
  now?: Date;
}): Promise<RelationshipOfferV1> {
  const body: RelationshipCredentialBodyV1 = {
    type: 'ap.relationship-credential.v1',
    kind: input.kind,
    subject: input.subject.toLowerCase() as Address,
    object: input.object.toLowerCase() as Address,
    chainId: CHAIN_ID,
    issuedAt: (input.now ?? new Date()).toISOString(),
    termsDigest: termsDigestOf(input.terms),
  };
  const digest = relationshipCredentialDigest(body);
  return { ...body, terms: input.terms, digest, signatures: { object: await input.signAsObject(digest) } };
}

/** Is this the shape of an offer a join may countersign? Nothing in it is believed — the a2a worker checks both
 *  signatures on chain — but a stash that carries something else is not sent there. */
export function relationshipOfferOf(v: unknown): RelationshipOfferV1 | null {
  const o = v as Partial<RelationshipOfferV1> | null;
  if (!o || typeof o !== 'object' || o.type !== 'ap.relationship-credential.v1') return null;
  if (!isAddr(o.subject) || !isAddr(o.object) || typeof o.digest !== 'string' || typeof o.signatures?.object !== 'string') return null;
  return o as RelationshipOfferV1;
}
