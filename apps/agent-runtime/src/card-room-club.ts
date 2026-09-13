// A CARD-ROOM CLUB IS ITS WORKSPACE AGENT, and this is what that agent does when the card room acts as it.
//
// A club (pokernight, `docs/WORKSPACES.md` §5.0 as amended 2026-09-13) is a `.workspace` Smart Agent its host
// custodies. It used to exist twice: as that agent at the Home and as a SQLite roster in the card room's
// Durable Object, with the card room the authority and the Home asked nothing. Now it exists ONCE. Who belongs
// is the organization's own membership (`org.membership:member:<sa>`, written at the workspace-join ceremony —
// spec 325); what the club calls itself, when it meets and how each night diverges from the rule are three
// records in the workspace's own vault (apctx:CardRoomClub / CardRoomClubSchedule / CardRoomClubNights —
// cr:Club, cr:ClubSchedule, cr:ClubNight in the card-room ontology). The card room keeps no copy.
//
// WHO WRITES THEM. The club's own agent — and the card room reaches it by acting AS the club under a
// service-agent wire the host signed once at charter (`workspace → the card room's session key`, pinned to
// the standard surface's one selector, revocable on chain). Every request is the same session assertion the
// house presents to a person's agent, verified the same way; the wire's delegator is the club, so the caller
// IS the club, and these two skills are the club acting on its own records. Authorization inside the club —
// who is a host, who may call a night off — is the card room's to enforce as the club's delegate; what the
// Home enforces is that only the club's delegate can write the club's records at all.
//
// NO MODEL. Like the card room's asks of a person's agent (`card-room.ts`), nothing here reaches the planner:
// a read is a vault read, a write is a vault put, and an unknown skill is a one-line refusal.
import type { Address } from '@agenticprimitives/types';
import { deriveStanding, membershipRows, type StandingDeps } from '@agenticprimitives/context';

/** The two verbs. Selectors are not the gate (the wire pins `harness.ask`); the NAME is what this dispatches on. */
export const CLUB_READ_SKILL = 'club.read' as const;
export const CLUB_WRITE_SKILL = 'club.write' as const;
export const CLUB_SKILLS = [CLUB_READ_SKILL, CLUB_WRITE_SKILL] as const;

/** The three records, by the short name the card room uses on the wire. */
export const CLUB_RECORDS = {
  profile: 'cardroom.club.profile',
  schedule: 'cardroom.club.schedule',
  nights: 'cardroom.club.nights',
} as const;
export type ClubRecordName = keyof typeof CLUB_RECORDS;

export function clubSkillOf(skill: string | null | undefined): typeof CLUB_READ_SKILL | typeof CLUB_WRITE_SKILL | null {
  const s = (skill ?? '').toLowerCase();
  return s === CLUB_READ_SKILL ? CLUB_READ_SKILL : s === CLUB_WRITE_SKILL ? CLUB_WRITE_SKILL : null;
}

export interface ClubDeps extends StandingDeps {
  readRecord: (subject: string, recordType: string) => Promise<unknown>;
  writeRecord: (subject: string, recordType: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
  /** The workspace's own record inventory and a batched read of chosen keys — how the roster is found. */
  survey: (subject: string) => Promise<Array<{ recordType: string }>>;
  readRecords: (subject: string, recordTypes: string[]) => Promise<Record<string, unknown>>;
  nameOf?: (address: string) => Promise<string | null>;
  now?: () => number;
}

export interface ClubReadInput {
  /** Whose standing to derive, when the card room is answering for a signed-in person. */
  agent?: string;
}

export interface ClubMemberOut {
  agent: string;
  name: string | null;
  role?: string;
}

export interface ClubReadOut {
  club: string;
  profile: unknown;
  schedule: unknown;
  nights: unknown;
  /** The organization's own membership records — the roster, from the club's word about who belongs. */
  roster: ClubMemberOut[];
  /** The named agent's standing at this club, derived (spec 353 S5): host = self or a verified steward. */
  you?: { agent: string; standing: 'host' | 'member' | 'none'; because: string };
}

export type ClubTurn =
  | { kind: 'answer'; data: Record<string, unknown> }
  | { kind: 'refused'; text: string };

const lc = (s: string) => s.toLowerCase();

/**
 * One club skill, decided and done. `caller` is the verified wire delegator and must BE the club: a message
 * from anybody else is refused before a record is read — the club's records are the club's to read and
 * write, and the card room's standing to do either is the wire, which names exactly one identity.
 */
export async function clubTurn(deps: ClubDeps, input: { caller: string; club: string; skill: string; material: Record<string, unknown> | null }): Promise<ClubTurn> {
  const club = lc(input.club);
  if (lc(input.caller) !== club) return { kind: 'refused', text: 'a club\'s records are read and written by the club itself — act as it under its wire' };
  const skill = clubSkillOf(input.skill);
  if (!skill) return { kind: 'refused', text: `${input.skill} is not something a club does` };
  const m = (input.material?.input ?? {}) as Record<string, unknown>;

  if (skill === CLUB_READ_SKILL) {
    const [profile, schedule, nights, roster] = await Promise.all([
      deps.readRecord(club, CLUB_RECORDS.profile).catch(() => null),
      deps.readRecord(club, CLUB_RECORDS.schedule).catch(() => null),
      deps.readRecord(club, CLUB_RECORDS.nights).catch(() => null),
      rosterOf(deps, club),
    ]);
    const out: ClubReadOut = { club, profile, schedule, nights, roster };
    const agent = typeof m.agent === 'string' && /^0x[0-9a-fA-F]{40}$/.test(m.agent) ? lc(m.agent) : null;
    if (agent) {
      // The card room asks on behalf of a person it signed in; their standing is THIS agent's derivation over
      // its own records and the chain — never a claim the card room makes.
      const st = await deriveStanding(deps, { principal: agent as Address, subject: club as Address }).catch(() => null);
      const standing = st?.relation === 'self' || st?.relation === 'steward' ? 'host' : st?.relation === 'member' ? 'member' : 'none';
      out.you = { agent, standing, because: st?.because ?? 'this agent could not read your links' };
    }
    return { kind: 'answer', data: out as unknown as Record<string, unknown> };
  }

  // club.write — one of the three records, replaced whole. The card room composes the record; the club's
  // agent keeps it. A name that is not one of the three is refused by name, so a typo cannot create a fourth.
  const record = typeof m.record === 'string' ? (m.record as ClubRecordName) : null;
  if (!record || !(record in CLUB_RECORDS)) return { kind: 'refused', text: `a club keeps ${Object.keys(CLUB_RECORDS).join(', ')} — not ${String(m.record)}` };
  if (m.value === undefined) return { kind: 'refused', text: 'club.write carries the record\'s new value' };
  const stamped = m.value && typeof m.value === 'object' && !Array.isArray(m.value)
    ? { ...(m.value as Record<string, unknown>), updatedAt: new Date(deps.now?.() ?? Date.now()).toISOString() }
    : m.value;
  const w = await deps.writeRecord(club, CLUB_RECORDS[record], stamped);
  if (!w.ok) return { kind: 'refused', text: w.error ?? `the club could not keep its ${record}` };
  return { kind: 'answer', data: { club, record, value: stamped } };
}

/** The roster from the organization's own membership records (an ended membership is not a member). */
export async function rosterOf(deps: Pick<ClubDeps, 'survey' | 'readRecords' | 'nameOf'>, club: string): Promise<ClubMemberOut[]> {
  const inventory = await deps.survey(club).catch(() => [] as Array<{ recordType: string }>);
  const keys = inventory.map((r) => r.recordType).filter((rt) => rt.startsWith('org.membership:member:')).slice(0, 500);
  if (!keys.length) return [];
  const bodies = await deps.readRecords(club, keys).catch(() => ({}));
  const rows = membershipRows(keys, bodies);
  const out: ClubMemberOut[] = rows.map((r) => ({ agent: r.agent, name: r.name, ...(r.role ? { role: r.role } : {}) }));
  if (deps.nameOf) {
    await Promise.all(out.filter((r) => !r.name).map(async (r) => { r.name = (await deps.nameOf!(r.agent).catch(() => null)) ?? null; }));
  }
  return out;
}
