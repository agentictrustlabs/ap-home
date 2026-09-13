// COACHES — a coaching SERVICE per game, hired at the Home (spec: the card-room coach arrangement).
//
// WHAT HIRING IS. Two custodial acts the person does for their own agent, and only the Home can do:
//   1. THE PLAYBOOK NAMES THE SPECIALIST — `specialists: [{ capability: 'poker.advise', executor: 'bob-coach.svc' },
//      { capability: 'poker.review', … }]` in the agent's archetype assignment, digest recomputed. Behaviour,
//      never authority (spec 376 W2): it says who the agent asks, never what that service may see.
//   2. THE STUDY GRANT — a vault-record-scope delegation: delegator the person, delegate the SERVICE (a `.svc`,
//      never a person), READ on the person's card-room records (`cardroom.hand`, `cardroom.hands:*`, `.style`,
//      `.read`, `.note`), WRITE on `cardroom.note` only, a year, revocable on chain. Signed with the person's own
//      credential and stored on their own object (`studygrant.put`), where their agent reads it to present at
//      every consultation. The coach's whole access; firing the coach is revoking this.
//
// PER GAME, because the specialist line is per capability and a coach knows one game. The table addresses the
// person's OWN agent and never learns the coach's endpoint; the coach reads the person's records at the
// person's vault and keeps nothing (the vault refuses these record types on a service principal).
import {
  buildCaveat,
  buildVaultRecordScopeCaveat,
  encodeTimestampTerms,
  hashDelegation,
  ROOT_AUTHORITY,
  type Delegation,
} from '@agenticprimitives/delegation';
import { definitionDigest, validateAgentHarnessDefinition, type AgentHarnessDefinitionV1, type SpecialistV1 } from '@agenticprimitives/capability-claims';
import type { Address, Hex } from '@agenticprimitives/types';
import { ensureCsrfToken, csrfHeaders } from '../csrf';
import { SESSION_KEY } from '../context/session';
import { readSsoCookie } from './sso-cookie';
import { CHAIN_ID, CONTRACTS } from './chain';
import type { SignHash } from '../connect-client';
import type { CapabilityClaim } from '../connect-client';

/** A game a coach can be hired for, and the card-room skills the person's agent advertises for it. */
export interface CoachedGame {
  id: 'poker' | 'canasta';
  label: string;
  /** The capabilities the person's agent hands to the coach (the specialist lines). */
  coached: string[];
  /** Everything the card room asks the person's agent for this game — what the agent's card must advertise. */
  agentCapabilities: CapabilityClaim[];
}

export const GAMES: CoachedGame[] = [
  {
    id: 'poker',
    label: "Texas Hold'em",
    coached: ['poker.advise', 'poker.review'],
    agentCapabilities: [
      { label: "Hold'em advice", capabilityId: 'poker.advise', asserted: true, description: 'Say what the person in a seat should do at Texas Hold’em, and why — consulted from the coaching service this agent’s playbook names, under the person’s study grant. Advice only: nothing here takes a turn.', tags: ['poker.advise', 'poker', 'advice', 'coach', 'pokernight'] },
      { label: "Hold'em hand record", capabilityId: 'poker.record', asserted: true, description: 'Receive a finished hand as one seat saw it, with the table’s counts per player, and put it into the person’s own vault. A vault put: no model.', tags: ['poker.record', 'poker', 'record', 'pokernight'] },
      { label: "Hold'em review", capabilityId: 'poker.review', asserted: true, description: 'When the person asks how they have been playing, forward the question to the coaching service their playbook names, with their study grant; the coach reviews their recorded hands and answers in its own name.', tags: ['poker.review', 'poker', 'review', 'coach', 'pokernight'] },
      { label: 'Who coaches me', capabilityId: 'poker.coach', asserted: true, description: 'Answer the card room: which coaching service this agent consults, and whether the person has been asked about hiring one; record the person’s answer in their own vault so they are asked once.', tags: ['poker.coach', 'poker', 'coach', 'pokernight'] },
    ],
  },
  {
    id: 'canasta',
    label: 'Classic Canasta',
    coached: ['canasta.advise', 'canasta.review'],
    agentCapabilities: [
      { label: 'Canasta advice', capabilityId: 'canasta.advise', asserted: true, description: 'Say what the person in a seat should do at Classic Canasta, and why — consulted from the coaching service this agent’s playbook names, under the person’s study grant. Advice only: nothing here takes a turn.', tags: ['canasta.advise', 'canasta', 'advice', 'coach', 'pokernight'] },
      { label: 'Canasta round record', capabilityId: 'canasta.record', asserted: true, description: 'Receive a finished round as one seat saw it, with the table’s counts, and put it into the person’s own vault under canasta’s own record names. A vault put: no model.', tags: ['canasta.record', 'canasta', 'record', 'pokernight'] },
      { label: 'Canasta review', capabilityId: 'canasta.review', asserted: true, description: 'When the person asks how they have been playing canasta, forward the question to the coaching service their playbook names, with their study grant; the coach reviews their recorded rounds and answers in its own name.', tags: ['canasta.review', 'canasta', 'review', 'coach', 'pokernight'] },
      { label: 'Who coaches me at canasta', capabilityId: 'canasta.coach', asserted: true, description: 'Answer the card room: which coaching service this agent consults for canasta, and whether the person has been asked about hiring one; record the person’s answer in their own vault so they are asked once.', tags: ['canasta.coach', 'canasta', 'coach', 'pokernight'] },
    ],
  },
];

/** A coaching service on offer: a Smart Agent somebody custodies, advertising the game's advise skill. */
export interface CoachOffer { name: string; displayName: string; blurb: string; game: CoachedGame['id'] }

/**
 * The coaches this Home knows about, by game. A short list today; discovery by capability (`poker.advise` on a
 * SERVICE in the registry) is the road, and the name is the only thing the arrangement needs — a coach from
 * anywhere is hired the same way.
 */
export const COACH_OFFERS: CoachOffer[] = [
  { game: 'poker', name: 'bob-coach.svc', displayName: "Bob's Hold'em coach", blurb: 'Tight-aggressive by conviction. Price before player, one sentence at the table, two or three after it; reviews decisions, not results; will not talk you into a line you have ruled out. Reads only your recorded hands, under your grant. Its tokens, not yours.' },
  { game: 'canasta', name: 'carol-coach.svc', displayName: "Carol's Canasta coach", blurb: 'Thirty years of partnership canasta. The pile before the plan, your partner’s card count before the pile, wilds for canastas and not for melds; one sentence at the table, three after it; reviews decisions, not results, and your partner as a count, never as blame. Reads only your recorded rounds, under your grant. Its tokens, not yours.' },
];

/**
 * What the study grant lets the coach read, and the one thing it may write — PER GAME. Hold'em's records keep
 * the bare names (`cardroom.hand`, …: every grant already issued names them, and the card room's own rule is
 * that no stamp means poker); every other game's carry the family (`cardroom.canasta.hand`). One cabinet per
 * game, so a hold'em coach's grant covers nothing of canasta's and firing one coach leaves the other's alone.
 */
export const STUDY_READS = ['vault:cardroom.hand', 'vault:cardroom.hands:*', 'vault:cardroom.style', 'vault:cardroom.read', 'vault:cardroom.note'] as const;
export const STUDY_APPENDS = ['vault:cardroom.note'] as const;
export function studyScopesFor(game: CoachedGame['id']): { reads: string[]; appends: string[] } {
  const infix = game === 'poker' ? '' : `${game}.`;
  return {
    reads: [`vault:cardroom.${infix}hand`, `vault:cardroom.${infix}hands:*`, `vault:cardroom.${infix}style`, `vault:cardroom.${infix}read`, `vault:cardroom.${infix}note`],
    appends: [`vault:cardroom.${infix}note`],
  };
}
export const STUDY_SERVER = 'demo-mcp';
export const STUDY_GRANT_DAYS = 365;

function homeBearer(): string {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const t = raw ? (JSON.parse(raw) as { token?: string }).token : undefined;
    if (t) return t;
  } catch { /* fall through */ }
  return readSsoCookie()?.token ?? '';
}

async function op<T>(person: Address, name: string, payload: Record<string, unknown>): Promise<T> {
  await ensureCsrfToken();
  const session = homeBearer();
  if (!session) throw new Error('no home session');
  const res = await fetch(`/a2a/interactions/${person.toLowerCase()}/${name}`, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ session, ...payload }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ok === false) throw new Error(String(body.error ?? `${name} failed (${res.status})`));
  return body as T;
}

export interface StudyGrantRow { coach: string; delegate: string; hash: string; resources: string[]; storedAt: string; revoked: boolean }

export async function listStudyGrants(person: Address): Promise<StudyGrantRow[]> {
  const r = await op<{ grants?: StudyGrantRow[] }>(person, 'studygrant.list', {});
  return r.grants ?? [];
}

/** Resolve a coach's typed name to its Smart Agent through this Home's naming read. */
export async function resolveCoach(name: string): Promise<Address | null> {
  const r = await fetch(`/connect/name-info?name=${encodeURIComponent(name)}`);
  if (!r.ok) return null;
  const b = (await r.json().catch(() => ({}))) as { exists?: boolean; agent?: string; deployed?: boolean };
  return b.exists && b.deployed && b.agent && /^0x[0-9a-fA-F]{40}$/.test(b.agent) ? (b.agent.toLowerCase() as Address) : null;
}

/** Mint + sign the study grant (the person signs with their own credential) and store it on their object. */
export async function hireCoachGrant(person: Address, coach: string, coachSA: Address, signHash: SignHash, game: CoachedGame['id'] = 'poker'): Promise<{ hash: string }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const scopes = studyScopesFor(game);
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  const d: Delegation = {
    delegator: person, delegate: coachSA, authority: ROOT_AUTHORITY,
    caveats: [
      buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, nowSec + STUDY_GRANT_DAYS * 86_400)),
      buildVaultRecordScopeCaveat([{ server: STUDY_SERVER, resources: scopes.reads, ops: ['read'] }, { server: STUDY_SERVER, resources: scopes.appends, ops: ['write'] }]),
    ],
    salt, signature: '0x',
  };
  d.signature = await signHash(hashDelegation(d, CHAIN_ID, CONTRACTS.delegationManager));
  if (!d.signature || d.signature === '0x') throw new Error('the study grant was not signed');
  const r = await op<{ hash?: Hex }>(person, 'studygrant.put', { coach, delegation: { ...d, salt: salt.toString() } });
  return { hash: r.hash ?? '' };
}

/** Drop this Home's copy of a coach's grant. NOT an on-chain revoke — that is the authority kill, under Security. */
export async function dropCoachGrant(person: Address, coach: string): Promise<void> {
  await op(person, 'studygrant.revoke', { coach });
}

// ── The playbook's specialist lines ─────────────────────────────────────────────────────────────────

interface AssignmentRecord { type: 'ap.archetype-assignment.v1'; archetypeId: string; archetypeVersion: string; definitionDigest: string; definition: AgentHarnessDefinitionV1 }

async function channels<T>(token: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch('/connect/channels', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const b = (await r.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string };
  if (!r.ok || b.ok !== true) throw new Error(b.error ?? `channels ${r.status}`);
  return b as T;
}

export async function readSpecialists(token: string, agent: Address): Promise<{ assigned: boolean; specialists: SpecialistV1[] }> {
  const b = await channels<{ record?: AssignmentRecord | null }>(token, { action: 'archetypeAssignmentGet', communityId: agent.toLowerCase() });
  return { assigned: !!b.record?.definition, specialists: b.record?.definition.specialists ?? [] };
}

/** The coach named for a game, from the specialist lines: the executor of its advise capability, when a service. */
export function coachFor(specialists: ReadonlyArray<SpecialistV1>, game: CoachedGame): string | null {
  const line = specialists.find((s) => s.capability === game.coached[0]);
  return line && /\.svc$/.test(line.executor) ? line.executor : null;
}

/**
 * Write the specialist lines for one game — `coach` names a service, `null` clears them — into the agent's
 * assignment, digest recomputed, everything else untouched. Refuses when no playbook is assigned (the
 * Behaviour → Playbook page assigns one; at onboarding the Home does it itself).
 */
export async function writeSpecialists(token: string, agent: Address, game: CoachedGame, coach: string | null): Promise<void> {
  const b = await channels<{ record?: AssignmentRecord | null }>(token, { action: 'archetypeAssignmentGet', communityId: agent.toLowerCase() });
  const rec = b.record;
  if (!rec?.definition) throw new Error('this agent has no playbook assigned yet — assign one under Behaviour → Playbook, then hire the coach');
  const others = (rec.definition.specialists ?? []).filter((s) => !game.coached.includes(s.capability));
  const specialists = coach ? [...others, ...game.coached.map((capability) => ({ capability, executor: coach }))] : others;
  const definition: AgentHarnessDefinitionV1 = { ...rec.definition };
  if (specialists.length) definition.specialists = specialists; else delete definition.specialists;
  const check = validateAgentHarnessDefinition(definition);
  if (!check.ok) throw new Error(`the playbook would not validate: ${check.errors[0]}`);
  const record: AssignmentRecord = { ...rec, definition, definitionDigest: definitionDigest(definition) };
  await channels(token, { action: 'archetypeAssignmentPut', communityId: agent.toLowerCase(), record });
}
