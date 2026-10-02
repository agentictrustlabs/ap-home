// A CARD-ROOM CLUB IS ITS WORKSPACE AGENT, and this is what that agent does when the card room acts as it.
//
// A club (pokernight, `docs/WORKSPACES.md` §5.0 as amended 2026-09-13) is a `.workspace` Smart Agent its host
// custodies. It used to exist twice: as that agent at the Home and as a SQLite roster in the card room's
// Durable Object, with the card room the authority and the Home asked nothing. Now it exists ONCE. What the
// club calls itself, when it meets and how each night diverges from the rule are three records in the
// workspace's own vault (apctx:CardRoomClub / CardRoomClubSchedule / CardRoomClubNights — cr:Club,
// cr:ClubSchedule, cr:ClubNight in the card-room ontology). The card room keeps no copy.
//
// WHO BELONGS IS NOT THE WORKSPACE'S TO SAY (the owner's rule, 2026-10-02; `org.ttl` §2). A `.workspace` agent
// is a SERVICE that coordinates a workspace (`ap:WorkspaceAgent ⊑ ap:ServiceAgent`, `aporg:coordinatedBy`); it
// cannot have members. The club's membership — `aporg:OrganizationMembership`, the `org.membership:member:<sa>`
// records written at the join ceremony (spec 325) — lives on the ORGANIZATION that GOVERNS the workspace
// (`aporg:governedBy`), which the workspace agent names in its own `workspace.governor` pointer. So the club's
// id stays the workspace address (the card room binds to it, the wire is the workspace's), the three records
// stay in the workspace's vault, and only WHERE MEMBERSHIP IS READ moves: the roster is the governor's records
// and a person's standing is derived against the governor. A club chartered before the pairing holds no pointer
// and still keeps its own records; it is read as it was (`governingSubjectOf`).
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
import { deriveStanding, governingSubjectOf, membershipRows, type StandingDeps } from '@agenticprimitives/context';

/** The two verbs. Selectors are not the gate (the wire pins `harness.ask`); the NAME is what this dispatches on. */
export const CLUB_READ_SKILL = 'club.read' as const;
export const CLUB_WRITE_SKILL = 'club.write' as const;
/** The club opens a TOPIC on its own board for a night (2026-09-18): the night's talk then lands where the club's
 *  people already talk, as posts from each character's own agent. Idempotent by title. */
export const CLUB_TOPIC_SKILL = 'club.topic' as const;
export const CLUB_SKILLS = [CLUB_READ_SKILL, CLUB_WRITE_SKILL, CLUB_TOPIC_SKILL] as const;

/** The three records, by the short name the card room uses on the wire. */
export const CLUB_RECORDS = {
  profile: 'cardroom.club.profile',
  schedule: 'cardroom.club.schedule',
  nights: 'cardroom.club.nights',
} as const;
export type ClubRecordName = keyof typeof CLUB_RECORDS;

export function clubSkillOf(skill: string | null | undefined): (typeof CLUB_SKILLS)[number] | null {
  const s = (skill ?? '').toLowerCase();
  return CLUB_SKILLS.find((k) => k === s) ?? null;
}

export interface ClubDeps extends StandingDeps {
  readRecord: (subject: string, recordType: string) => Promise<unknown>;
  writeRecord: (subject: string, recordType: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
  /** The workspace's own record inventory and a batched read of chosen keys — how the roster is found. */
  survey: (subject: string) => Promise<Array<{ recordType: string }>>;
  readRecords: (subject: string, recordTypes: string[]) => Promise<Record<string, unknown>>;
  /** The organization opens (or finds, by title) an open topic on its own board — `internal.channels.create`. */
  openTopic?: (subject: string, title: string) => Promise<{ channelId: string; title: string; created: boolean }>;
  nameOf?: (address: string) => Promise<string | null>;
  /** A short in-isolate memo (the Worker's `remembered`, a minute): the founder's name and a POSITIVE standing are
   *  remembered — a club page is read several times a minute by the same person, and each derivation is a tree
   *  read and a chain check. `none` is never remembered: the person who just joined must not read as a stranger
   *  for a minute after the ceremony. */
  remember?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
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
  /** The GOVERNING organization's own membership records — the roster, from the organization's word about who
   *  belongs. (A legacy club with no governor: its own records, as before.) */
  roster: ClubMemberOut[];
  /** The organization whose membership this roster is, when the club's workspace names one. Absent for a legacy
   *  club that still holds its own records. The card room shows it; it decides nothing on it. */
  governedBy?: string;
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
    const t0 = Date.now();
    const remember = deps.remember ?? (<T,>(_k: string, fn: () => Promise<T>) => fn());
    const agent = typeof m.agent === 'string' && /^0x[0-9a-fA-F]{40}$/.test(m.agent) ? lc(m.agent) : null;
    // THE SUBJECT OF MEMBERSHIP IS THE GOVERNOR — one pointer read, remembered with the rest of the club's
    // reads, before the roster and the standing are asked for. A club with no pointer answers itself.
    const { subject: holder, governor } = await remember(`club-governor:${club}`, () => governingSubjectOf(deps.readRecord, club as Address));
    // THE PERSON'S STANDING is derived beside the records, not after them — it depends on their tree and the
    // chain, not on anything read here. A positive answer is remembered a minute; `none` is asked again. The
    // memo is keyed by the club AND the holder: a club whose pointer moves must not answer from the old one.
    const standingP = agent
      ? remember(`club-standing:${agent}:${club}:${holder}`, async () => {
          const st = await deriveStanding(deps, { principal: agent as Address, subject: holder }).catch(() => null);
          const standing = st?.relation === 'self' || st?.relation === 'steward' ? 'host' : st?.relation === 'member' ? 'member' : 'none';
          const you = { agent, standing, because: st?.because ?? 'this agent could not read your links' } as NonNullable<ClubReadOut['you']>;
          if (standing === 'none') throw Object.assign(new Error('not remembered'), { you });
          return you;
        }).catch((e: unknown) => (e as { you?: NonNullable<ClubReadOut['you']> }).you ?? { agent, standing: 'none' as const, because: 'this agent could not read your links' })
      : Promise.resolve(undefined);
    const [profile, schedule, nights, roster, you] = await Promise.all([
      deps.readRecord(club, CLUB_RECORDS.profile).catch(() => null),
      deps.readRecord(club, CLUB_RECORDS.schedule).catch(() => null),
      deps.readRecord(club, CLUB_RECORDS.nights).catch(() => null),
      rosterOf(deps, holder),
      standingP,
    ]);
    const out: ClubReadOut = { club, profile, schedule, nights, roster, ...(governor ? { governedBy: governor } : {}), ...(you ? { you } : {}) };
    // WHO TO SHOW AS HOST: the founder the profile names (their standing is still derived when they ask),
    // with the name the estate calls them — a member's roster row carries a name, the steward's would not.
    const founder = profile && typeof profile === 'object' && typeof (profile as { foundedBy?: unknown }).foundedBy === 'string' ? lc(String((profile as { foundedBy: string }).foundedBy)) : null;
    if (founder && deps.nameOf) (out as ClubReadOut & { founderName?: string | null }).founderName = await remember(`name:${founder}`, () => deps.nameOf!(founder)).catch(() => null);
    console.log(`[club.read] ${Date.now() - t0}ms`);
    return { kind: 'answer', data: out as unknown as Record<string, unknown> };
  }

  // club.topic — the night's topic on the club's board, opened once and found by its title thereafter. The card
  // room keeps the channel id on the night; the club's board keeps the talk.
  if (skill === CLUB_TOPIC_SKILL) {
    const title = typeof m.title === 'string' ? m.title.trim().slice(0, 80) : '';
    if (!title) return { kind: 'refused', text: 'club.topic carries the topic\'s title' };
    if (!deps.openTopic) return { kind: 'refused', text: 'this club cannot open topics here' };
    try {
      const t = await deps.openTopic(club, title);
      return { kind: 'answer', data: { club, channelId: t.channelId, title: t.title, created: t.created } };
    } catch (e) {
      return { kind: 'refused', text: e instanceof Error ? e.message : String(e) };
    }
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

/** The roster from an organization's own membership records (an ended membership is not a member). `holder` is
 *  the agent whose vault holds them: the club's GOVERNOR, resolved by the caller — or the club itself when it has
 *  none (legacy). Surveying the workspace agent of a governed club finds nothing, correctly: it holds no members. */
export async function rosterOf(deps: Pick<ClubDeps, 'survey' | 'readRecords' | 'nameOf'>, holder: string): Promise<ClubMemberOut[]> {
  const inventory = await deps.survey(holder).catch(() => [] as Array<{ recordType: string }>);
  const keys = inventory.map((r) => r.recordType).filter((rt) => rt.startsWith('org.membership:member:')).slice(0, 500);
  if (!keys.length) return [];
  const bodies = await deps.readRecords(holder, keys).catch(() => ({}));
  const rows = membershipRows(keys, bodies);
  const out: ClubMemberOut[] = rows.map((r) => ({ agent: r.agent, name: r.name, ...(r.role ? { role: r.role } : {}) }));
  if (deps.nameOf) {
    await Promise.all(out.filter((r) => !r.name).map(async (r) => { r.name = (await deps.nameOf!(r.agent).catch(() => null)) ?? null; }));
  }
  return out;
}
