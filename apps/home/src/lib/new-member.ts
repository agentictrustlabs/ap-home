// First-connect provisioning — the DECISIONS, with nothing that touches the network.
//
// A person who signs up gets an identity and no way to hold money, and (on the phone/email/social
// paths) no name of any kind, so every app that needs either sends them on an errand. The Home can
// do both while it is already deploying their account. What it must NOT do is do it for everybody:
// this is the onboarding path every member of the platform walks, so the requirement is DECLARED by
// the relying app (`new_member` in the whitelabel registry) and honoured here. An app that declares
// nothing gets exactly the ceremony it got before this file existed.
//
// Everything here is pure so the three rules that matter can be TESTED rather than reasoned about
// at a UI in the middle of a sign-up:
//
//   · absent config ⇒ nothing (`newMemberPlan`)
//   · already has it ⇒ don't make a second one (`newMemberWork`)
//   · not a new home ⇒ don't run at all (`isNewHomeMoment`)
//
// The effects themselves live in `components/onboarding/NewMemberSetup.tsx`, which reuses the
// ordinary create ceremony (`createAgentWithBirthrights`) and the ordinary profile write
// (`seedImpactProfileFields`) rather than growing a second implementation of either.
import type { NewMemberOnboarding, RelyingApp } from '../whitelabel/schema';

/** How the member is asked for their human name: not at all, offered, or insisted on. */
export type NameAsk = 'off' | 'optional' | 'required';

/** What THIS app asked for, normalized. The UI reads this and nothing else about the registry. */
export interface NewMemberPlan {
  /** Deploy + record the member's own personal treasury. Always nameless — see the schema. */
  treasury: boolean;
  /** Ask for their human (profile) name. NEVER a `<label>.me` handle claim. */
  name: NameAsk;
}

/** The plan for an app that declared nothing — and therefore the plan for every app but the ones
 *  that opted in. Exported because "does this equal NOTHING_TO_DO" is the assertion the tests and
 *  the mount points both want to make. */
export const NO_NEW_MEMBER: NewMemberPlan = { treasury: false, name: 'off' };

/** True when this plan asks for nothing at all — the caller renders no screen and does no work. */
export function planIsEmpty(plan: NewMemberPlan): boolean {
  return !plan.treasury && plan.name === 'off';
}

/**
 * Read a relying app's declared first-connect provisioning.
 *
 * FAIL-QUIET AND NARROW: an absent entry, an absent `new_member`, an empty object, or a value that
 * isn't one of the two we understand all resolve to {@link NO_NEW_MEMBER}. A member-registered
 * client (looked up over `/connect/client-info`, which does not carry this field) lands here too,
 * so a self-service registration can never turn provisioning on for itself — only a curated entry
 * in `whitelabel.relyingApps` can.
 */
export function newMemberPlan(app?: Pick<RelyingApp, 'new_member'> | null): NewMemberPlan {
  const cfg: NewMemberOnboarding | undefined = app?.new_member;
  if (!cfg) return NO_NEW_MEMBER;
  const ask = cfg.collect_name;
  return {
    treasury: cfg.personal_treasury === true,
    name: ask === 'required' || ask === 'optional' ? ask : 'off',
  };
}

/** What the member already has. Read once, before anything is created. */
export interface MemberState {
  /** They already hold at least one `person-treasury` in their own agent tree. */
  hasTreasury: boolean;
  /** Their profile already carries a human name (first and/or last). */
  hasProfileName: boolean;
}

/** What is actually left to do for THIS member, after subtracting what they already have. */
export interface NewMemberWork {
  treasury: boolean;
  name: boolean;
}

/**
 * THE IDEMPOTENCE DECISION.
 *
 * A returning member, a resumed ceremony, a double-invoked effect and a member who made a treasury
 * by hand last week must all come out the same: nothing to do. So the question is never "is this
 * their first time" (unknowable, and wrong the moment a ceremony is retried) — it is "do they
 * already have the thing", asked of their real agent tree and their real profile. Both answers are
 * subtractive, which makes running this twice indistinguishable from running it once.
 */
export function newMemberWork(plan: NewMemberPlan, state: MemberState): NewMemberWork {
  return {
    treasury: plan.treasury && !state.hasTreasury,
    name: plan.name !== 'off' && !state.hasProfileName,
  };
}

/** True when there is nothing left to do — the gate resolves immediately and renders no screen. */
export function workIsEmpty(work: NewMemberWork): boolean {
  return !work.treasury && !work.name;
}

/** The moment a mount point is looking at, in the terms that decide whether it is a new home. */
export interface HomeMoment {
  /** The member's own Smart Agent exists on chain. Nothing can be parented to it until it does. */
  deployed: boolean;
  /** A home session that can sign for that agent. Without it there is no ceremony to run. */
  hasSession: boolean;
  /** This credential is being ADDED to an account that already exists (spec 320 link/facet path:
   *  "add a phone", "add an email", "link Google"). Those members already have a home — and quite
   *  possibly a treasury and a name — and are emphatically not signing up. */
  linkingCredential: boolean;
}

/**
 * THE "IS THIS A GENUINELY NEW HOME" PREDICATE.
 *
 * Deliberately conservative: it says no whenever it cannot see a deployed agent and a session to
 * act with, and it says no on the link/facet paths outright. Saying no costs a member nothing (the
 * next connect asks again, and their home already has both surfaces), whereas saying yes on a link
 * path would run account-creation work against somebody's established account.
 *
 * It does NOT try to decide "first ever visit". That question has no honest answer here — a Google
 * member returns with `fresh: true` on every OAuth round trip, and an OTP bootstrap opens its
 * session with `fresh: false` — which is exactly why {@link newMemberWork} carries the weight.
 */
export function isNewHomeMoment(m: HomeMoment): boolean {
  if (m.linkingCredential) return false;
  return m.deployed && m.hasSession;
}

/**
 * Split what a person typed into the first/last pair the profile stores.
 *
 * They are asked for "your name", not for two fields, because one field is what a person can answer
 * without thinking about it. One word is a first name (plenty of people give only that, and a
 * mononym is a real name); everything after the first space is the last name, so "Mary Anne Evans"
 * keeps all of itself. Returns empty strings for input that is only whitespace — the caller treats
 * that as "not given" rather than writing blanks over a profile.
 */
export function splitPersonName(raw: string): { firstName: string; lastName: string } {
  const clean = raw.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!clean) return { firstName: '', lastName: '' };
  const cut = clean.indexOf(' ');
  if (cut < 0) return { firstName: clean, lastName: '' };
  return { firstName: clean.slice(0, cut), lastName: clean.slice(cut + 1) };
}

/** The human name a profile carries, or '' when it carries none. The one place first+last are
 *  joined, so the header, the connect hand-off and the "do they already have a name" check cannot
 *  disagree about what counts as having one. */
export function personDisplayName(contact?: { firstName?: string; lastName?: string } | null): string {
  return [contact?.firstName, contact?.lastName]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

// ── Sharing the name with the app that asked ──────────────────────────────────────────────────
//
// Collecting a name and HANDING IT TO AN APP are two different acts, so they are two different
// switches. `new_member.collect_name` says whether the Home asks for one; `allowed_scopes`
// containing `profile` says whether an app is permitted to receive it. An app can be given the
// name without ever asking for one (a member who already has a profile name), and an app could ask
// for a name it never receives. Neither is a special case — they are just the two switches off the
// same person.
//
// `allowed_scopes` is the gate rather than a `scope=` request parameter because the registry entry
// is CURATED and the parameter is attacker-supplied: the broker does not parse request scopes
// anywhere today, and a request-driven gate would let any origin that can form a URL ask for a
// member's name. Same reasoning as the app's name and logo at consent (registry, never the URL).

/** The scope that means "this app may receive the person's profile name". */
export const PROFILE_SCOPE = 'profile';

/** Is this client registered to receive the member's human name? Unknown/member-registered clients
 *  are `false` — a self-service registration cannot grant itself the scope (see `newMemberPlan`). */
export function sharesProfileName(app?: Pick<RelyingApp, 'allowed_scopes'> | null): boolean {
  return Array.isArray(app?.allowed_scopes) && app.allowed_scopes.includes(PROFILE_SCOPE);
}

/**
 * What goes on the id_token's `agent_name` claim.
 *
 * `mintIdToken` omits the claim entirely when the value is empty, and a nameless account has no
 * handle — which is the whole reason a player renders as `0x1a2b…9f0e`. The handle ALWAYS wins when
 * there is one, so nothing an app resolves today changes meaning; the profile name can only turn an
 * ABSENT claim into a present one. (`/token` also returns the profile name in its own field, so an
 * app that needs to tell the two apart can.)
 */
export function nameClaimForIdToken(handle: string | undefined, profileName: string | undefined): string | undefined {
  return (handle ?? '').trim() || (profileName ?? '').trim() || undefined;
}

/**
 * The consent line for that sharing, folded into a template's "This app can" list.
 *
 * A name handed over silently is the thing to avoid: the disclosure at the moment of COLLECTION
 * (the setup screen names the app) covers a member who is typing it now, and this covers everyone
 * else — the returning member whose name is already on file and who only ever sees the consent
 * sheet. Pure, and it returns the template UNCHANGED for every app without the scope, so no other
 * app's consent copy moves.
 */
export function withProfileNameConsent<T extends { canDo: string[]; cannotDo: string[] }>(
  template: T,
  app?: Pick<RelyingApp, 'allowed_scopes'> | null,
): T {
  if (!sharesProfileName(app)) return template;
  const line = 'See the name you go by, so it can show you to other people by name';
  if (template.canDo.includes(line)) return template;
  return { ...template, canDo: [...template.canDo, line] };
}
