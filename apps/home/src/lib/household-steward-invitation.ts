// A HOUSEHOLD'S SECOND STEWARD — the smallest invitation that gives a person STEWARD standing in a household, the way
// its founder holds it (agentic-trust 1.9.0: a person leads a household only through a role assignment made real by a
// delegation FROM THE HOUSEHOLD TO THEM; a "leader" label alone is not authority).
//
// THE GRANT IS THE FOUNDER'S GRANT, MINTED AGAIN. The founder holds the household's oversight delegation
// (`siteCaveats`: governance targets, time-boxed, value 0 — the shape every stewardship check recognises). A steward
// whose sign-in holds the household's keys signs THE SAME KIND OF GRANT, household → invitee, on the approval page
// (`issueSiteDelegation`). Nothing new is minted: no template, no caveat, no enforcer.
//
// TWO PEOPLE, TWO HOMES. The inviting steward approves in their Home (the household signs); the invitee ACCEPTS in
// their own Home (their link to the household becomes `steward`, carrying that grant). Only then does Home list them
// as a steward. An app never invites or accepts on its own: both writes need a Home session.
//
// ENDING IT is revoking the household's grant on chain (the DelegationManager). Home has no page for that yet, so an
// accepted invitation cannot be "cancelled" here — it is said, never faked.
//
// Pure: no I/O. The route (server/connect/household-stewards.ts) and the page call these, with the chain check injected.

export type InvitationState = 'pending' | 'accepted' | 'cancelled';

/** The household's oversight grant to the invitee, as a delegation wire (signature included). */
export type Wire = { delegator?: string; delegate?: string; signature?: string; caveats?: unknown[]; [k: string]: unknown };

export interface StewardInvitation {
  org: string;
  invitee: string;
  /** What the inviting steward called them (the app's label). Words only. */
  label: string;
  invitedBy: string;
  delegation: Wire;
  state: InvitationState;
  createdAt: number;
  acceptedAt?: number;
  cancelledAt?: number;
}
/** What leaves Home about an invitation: never the grant itself. */
export type InvitationView = Omit<StewardInvitation, 'delegation'>;
export const viewOf = ({ delegation: _d, ...rest }: StewardInvitation): InvitationView => rest;

/** One entry of the household's steward roster at Home: a steward Home has VERIFIED (the founder on their first read,
 *  an invitee on acceptance). Re-verified on every read; one that no longer verifies is `lapsed`. */
export interface StewardEntry { agent: string; delegation: Wire; since: number; via: 'founder' | 'invitation' }

export type Verify = (org: string, person: string, wire: unknown) => Promise<boolean>;

const ADDR = /^0x[0-9a-f]{40}$/;
const lc = (s: unknown): string => String(s ?? '').trim().toLowerCase();
export const isAgent = (s: unknown): s is string => ADDR.test(lc(s));

// ── the page's request ─────────────────────────────────────────────────────────────────────────────────────
export interface RelyingAppLike { client_id: string; name?: string; redirect_uris: string[]; steward_invitations?: boolean }
export type PageRequest =
  | { mode: 'invite'; household: string; person: string; label: string; appName: string; returnTo: string }
  | { mode: 'accept'; household: string; member?: string; appName: string; returnTo: string };

/** `/household-steward-invitation?household&person&name&from&return` (a steward invites) or `…?action=accept&household&member&from&return`
 *  (the invitee accepts). Refused unless the app is registered for steward invitations and the return is one of its own. */
export function parsePageRequest(search: string, apps: readonly RelyingAppLike[]): { ok: true; request: PageRequest } | { ok: false; error: string } {
  const q = new URLSearchParams(search);
  const app = apps.find((a) => a.client_id === q.get('from'));
  const bad = { ok: false as const, error: 'This request is invalid. Return to the app and try again.' };
  if (!app?.steward_invitations) return bad;
  const returnTo = q.get('return') ?? '';
  if (!app.redirect_uris.includes(returnTo)) return bad;
  const household = lc(q.get('household'));
  if (!isAgent(household)) return bad;
  const appName = app.name ?? app.client_id;
  if (q.get('action') === 'accept') {
    const member = q.get('member');
    if (member !== null && !isAgent(member)) return bad;
    return { ok: true, request: { mode: 'accept', household, ...(member ? { member: lc(member) } : {}), appName, returnTo } };
  }
  const person = lc(q.get('person'));
  if (!isAgent(person)) return bad;
  const label = (q.get('name') ?? '').trim().slice(0, 100) || person;
  return { ok: true, request: { mode: 'invite', household, person, label, appName, returnTo } };
}

// ── transitions ───────────────────────────────────────────────────────────────────────────────────────────
export class StewardInvitationError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'StewardInvitationError';
  }
}
const refuse = (code: string, message: string, status: number): never => { throw new StewardInvitationError(code, message, status); };

/** A steward invites. `callerIsSteward` is the caller's own verified stewardship; `alreadySteward` whether the invitee
 *  already holds a verified grant on Home's roster. The wire must BE the household's oversight grant to the invitee. */
export async function invite(input: {
  org: string; caller: string; invitee: unknown; label?: unknown; delegation: unknown;
  callerIsSteward: boolean; alreadySteward: boolean; existing: StewardInvitation | null; now: number; verify: Verify;
}): Promise<StewardInvitation> {
  const org = lc(input.org), caller = lc(input.caller), invitee = lc(input.invitee);
  if (!isAgent(org) || !isAgent(invitee)) refuse('invalid_request', 'A household and an invitee (agent addresses) are required.', 400);
  if (!input.callerIsSteward) refuse('not_a_steward', 'Only a steward of this household can invite another steward.', 403);
  if (invitee === caller) refuse('invalid_request', 'You are already a steward of this household.', 400);
  if (input.alreadySteward) refuse('already_steward', 'Home already lists them as a steward of this household.', 409);
  const wire = input.delegation as Wire | null;
  const shaped = !!wire && typeof wire === 'object' && lc(wire.delegator) === org && lc(wire.delegate) === invitee;
  if (!shaped || !(await input.verify(org, invitee, wire).catch(() => false)))
    refuse('not_a_stewardship_grant', 'That is not a live stewardship grant from this household to them.', 400);
  if (input.existing?.state === 'accepted') refuse('already_steward', 'They already accepted a steward invitation for this household.', 409);
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 100) : invitee;
  return { org, invitee, label, invitedBy: caller, delegation: wire!, state: 'pending', createdAt: input.now };
}

/** The invitee accepts: the household's grant must still verify. */
export async function accept(input: { caller: string; invitation: StewardInvitation | null; now: number; verify: Verify }): Promise<StewardInvitation> {
  const inv = input.invitation;
  if (!inv || inv.invitee !== lc(input.caller)) refuse('no_invitation', 'There is no steward invitation for you in this household.', 404);
  if (inv!.state === 'accepted') return inv!;
  if (inv!.state !== 'pending') refuse('no_invitation', 'That steward invitation was cancelled.', 404);
  if (!(await input.verify(inv!.org, inv!.invitee, inv!.delegation).catch(() => false)))
    refuse('invitation_lapsed', 'The household’s grant in this invitation no longer verifies (it expired or was revoked). Ask a steward to invite you again.', 409);
  return { ...inv!, state: 'accepted', acceptedAt: input.now };
}

/** A steward cancels a PENDING invitation. An accepted one is ended only by revoking the household's grant on chain. */
export function cancel(input: { callerIsSteward: boolean; invitation: StewardInvitation | null; now: number }): StewardInvitation {
  if (!input.callerIsSteward) refuse('not_a_steward', 'Only a steward of this household can cancel a steward invitation.', 403);
  const inv = input.invitation ?? refuse('no_invitation', 'There is no steward invitation for that person.', 404);
  if (inv.state === 'accepted')
    refuse('revoke_required', 'They accepted, so they are a steward. Ending that means revoking the household’s grant to them on chain; Home has no page for that yet.', 409);
  if (inv.state === 'cancelled') return inv;
  return { ...inv, state: 'cancelled', cancelledAt: input.now };
}

// ── the roster ────────────────────────────────────────────────────────────────────────────────────────────
export interface RosterPerson { agent: string; relationship: 'steward' | 'member'; verified: boolean; via: 'stewardship-wire' | 'membership'; since?: number }
export interface Roster {
  org: string;
  you: 'steward' | 'member' | 'invited';
  people: RosterPerson[];
  /** Stewards Home recorded whose grant no longer verifies (expired or revoked). Not stewards. */
  lapsed: string[];
  invitations: InvitationView[];
}

/**
 * Who Home lists for a household, each said with how it knows. A steward is one whose household grant VERIFIES now
 * (re-checked on every read); a member is one Home's member index lists (a membership the person signed), unverified
 * as authority because membership is none.
 */
export async function assembleRoster(input: {
  org: string; you: 'steward' | 'member'; stewards: StewardEntry[]; members: string[]; invitations: StewardInvitation[]; verify: Verify;
}): Promise<Roster> {
  const org = lc(input.org);
  const checked = await Promise.all(input.stewards.map(async (s) => ({ s, ok: await input.verify(org, s.agent, s.delegation).catch(() => false) })));
  const people: RosterPerson[] = [];
  const seen = new Set<string>();
  for (const { s, ok } of checked) {
    if (!ok || seen.has(s.agent)) continue;
    seen.add(s.agent);
    people.push({ agent: s.agent, relationship: 'steward', verified: true, via: 'stewardship-wire', since: s.since });
  }
  const lapsed = [...new Set(checked.filter((c) => !c.ok && !seen.has(c.s.agent)).map((c) => c.s.agent))];
  for (const m of input.members.map(lc)) {
    if (!isAgent(m) || seen.has(m)) continue;
    seen.add(m);
    people.push({ agent: m, relationship: 'member', verified: false, via: 'membership' });
  }
  return { org, you: input.you, people, lapsed, invitations: input.invitations.map(viewOf) };
}

/** Add a verified steward to the roster (founder on first read, invitee on acceptance). Same array back when present. */
export function withSteward(list: StewardEntry[], entry: StewardEntry): StewardEntry[] {
  const at = list.findIndex((s) => s.agent === entry.agent);
  if (at < 0) return [...list, entry];
  // a re-issued grant replaces a stale one; the original `since` and `via` stand
  if (list[at]!.delegation?.signature === entry.delegation?.signature) return list;
  return list.map((s, i) => (i === at ? { ...s, delegation: entry.delegation } : s));
}

// ── KV keys (one place) ───────────────────────────────────────────────────────────────────────────────────
export const KEYS = {
  roster: (org: string) => `household-stewards:${lc(org)}`,
  invite: (org: string, invitee: string) => `household-steward-invite:${lc(org)}:${lc(invitee)}`,
  invites: (org: string) => `household-steward-invites:${lc(org)}`,
};

/** The message the page sends the app that opened it. A hint only: the app confirms by reading. */
export const STEWARD_INVITATION_MESSAGE = 'ap-household-steward-invitation';
