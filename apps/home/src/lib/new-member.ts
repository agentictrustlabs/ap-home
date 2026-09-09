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
import type { MemberCurrency, NewMemberOnboarding, RelyingApp } from '../whitelabel/schema';

/** How the member is asked for their human name: not at all, offered, or insisted on. */
export type NameAsk = 'off' | 'optional' | 'required';

/** What THIS app asked for, normalized. The UI reads this and nothing else about the registry. */
export interface NewMemberPlan {
  /** Deploy + record the member's own personal treasury. Always nameless — see the schema. */
  treasury: boolean;
  /** Ask for their human (profile) name. NEVER a `<label>.me` handle claim. */
  name: NameAsk;
  /** The app's own coin: what the account holds, what goes in it, and who may move it. `null` for
   *  every app that declared none — see {@link memberCurrencyPlan}. */
  currency: MemberCurrencyPlan | null;
}

/** The plan for an app that declared nothing — and therefore the plan for every app but the ones
 *  that opted in. Exported because "does this equal NOTHING_TO_DO" is the assertion the tests and
 *  the mount points both want to make. */
export const NO_NEW_MEMBER: NewMemberPlan = { treasury: false, name: 'off', currency: null };

/** True when this plan asks for nothing at all — the caller renders no screen and does no work.
 *
 *  A declared currency counts as asking for something ONLY when there is coin to put in an account:
 *  a spend-grant-only currency is minted in the grant leg of the connect and needs no setup screen,
 *  and a member who already has both an account and coin falls through {@link newMemberWork} a moment
 *  later anyway. */
export function planIsEmpty(plan: NewMemberPlan): boolean {
  return !plan.treasury && plan.name === 'off' && !(plan.currency && plan.currency.initialAmount > 0n);
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
export function newMemberPlan(app?: Pick<RelyingApp, 'new_member' | 'paymentConfig'> | null): NewMemberPlan {
  const cfg: NewMemberOnboarding | undefined = app?.new_member;
  if (!cfg) return NO_NEW_MEMBER;
  const ask = cfg.collect_name;
  return {
    treasury: cfg.personal_treasury === true,
    name: ask === 'required' || ask === 'optional' ? ask : 'off',
    currency: memberCurrencyPlan(app),
  };
}

/** What the member already has. Read once, before anything is created. */
export interface MemberState {
  /** They already hold at least one `person-treasury` in their own agent tree. */
  hasTreasury: boolean;
  /** Their profile already carries a human name (first and/or last). */
  hasProfileName: boolean;
  /** How much of the app's coin that account already holds. `null` = not read, or not readable —
   *  which fails CLOSED to "do not seed" (see {@link shouldSeedCoin}). An account that does not
   *  exist yet holds none of it, so a brand-new member is `0n`, not `null`. */
  coinBalance?: bigint | null;
}

/** What is actually left to do for THIS member, after subtracting what they already have. */
export interface NewMemberWork {
  treasury: boolean;
  name: boolean;
  /** Put the declared opening amount into their account. */
  seed: boolean;
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
  const treasury = plan.treasury && !state.hasTreasury;
  return {
    treasury,
    name: plan.name !== 'off' && !state.hasProfileName,
    // An account we are ABOUT to create holds nothing, so it is always seedable; an account that
    // already exists is judged on what it actually holds. Both go through the one rule.
    seed: shouldSeedCoin(plan.currency, treasury ? 0n : (state.coinBalance ?? null)),
  };
}

/** True when there is nothing left to do — the gate resolves immediately and renders no screen. */
export function workIsEmpty(work: NewMemberWork): boolean {
  return !work.treasury && !work.name && !work.seed;
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

// ── The app's own coin ────────────────────────────────────────────────────────────────────────
//
// THE PROBLEM THIS SOLVES. An app with its own currency needs three things to be true about a member
// before it can deal with them: they hold an account that can carry the coin, there is some coin in
// it, and the app's own agent is allowed to move it. The Home did the first (`personal_treasury`),
// nobody did the second, and the third was a SECOND full redirect ceremony the app sent the member
// back out on — so joining a card room was two consents and an errand.
//
// All three are now declared by the app (`new_member.currency`) and done in the one connect the
// member was already making. Nothing here is poker: the coin's name, its opening balance and the
// agent that may move it are all registry data, so the next app with a service type and a coin of
// its own is a registry entry and not a code path.
//
// WHAT IS REUSED RATHER THAN REBUILT:
//   · the account            → `createAgentWithBirthrights` (the /choose-treasury + portal ceremony)
//   · the coin in it         → `fundThroughHarness` → `treasury.fund` (the portal's Fund button,
//                              which is a faucet mint through the harness, in the member's name)
//   · the spend grant        → `issuePaymentDelegation` + the enrol-time payment leg of
//                              `givePermission` (the x402 / buy-in mandate), moved to this connect
// There is no second grant path, no second funding path, and no second create path.


/** A 20-byte hex address that is not the zero address. The zero address is how a registry entry says
 *  "this token is not deployed yet" without needing a second field for it. */
function isRealAddress(v: unknown): v is `0x${string}` {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/.test(v);
}

/** The caps a mandate is bound by, as atomic-unit strings — `paymentConfig`'s, unchanged. */
export interface CoinCaps {
  maxAmountPerCharge: string;
  maxAggregate: string;
  maxRedemptionsPerWindow?: number;
  windowSeconds?: number;
}

/** What THIS app's currency asks for, normalized. The UI and the connect read this and nothing else
 *  about the registry — which is what keeps "Sheqel" out of every component that mentions money. */
export interface MemberCurrencyPlan {
  asset: `0x${string}`;
  /** Member-facing singular ("Sheqel") and plural ("Sheqels"). */
  name: string;
  plural: string;
  decimals: number;
  /** Atomic units to open an empty account with; `0n` for no seeding. */
  initialAmount: bigint;
  /** The app declared this coin is play money. Necessary for seeding, and NOT sufficient — the Home
   *  proves the token is open-mint on chain before it mints (see `lib/member-coin.ts`). */
  faucet: boolean;
  /** Mint the spend mandate in this connect. */
  spendGrant: boolean;
  /** Where the coin lands when the app collects it (`paymentConfig.payee`). */
  payee: `0x${string}`;
  /** WHO may present the mandate — the app's service agent, or the payee when it collects for
   *  itself. `null` means OPEN (a `push` mandate, redeemed by whoever holds it), which is what the
   *  x402 reader path has always minted. */
  redeemer: `0x${string}` | null;
  caps: CoinCaps;
}

/**
 * Read an app's declared currency.
 *
 * FAIL-QUIET AND WHOLE. Every one of these resolves to `null` — no account seeded, no mandate minted,
 * today's behaviour exactly:
 *   · no `currency` block at all (every app in the registry but the one that opted in)
 *   · no `paymentConfig` — there are no caps to bound a spend grant with, and an UNCAPPED grant over
 *     someone's money is not a thing to fall back to
 *   · an `asset` that is not a real address — which is how a not-yet-deployed token is written down
 *   · an `asset` that DISAGREES with `paymentConfig.asset`
 *
 * That last one is the important one. Two fields naming the coin is a real risk, so the disagreement
 * is not resolved, it is REFUSED: opening an account for one token while minting a mandate over
 * another is the failure mode worth making impossible, and a half-configured entry should look
 * broken (and test-fail) rather than work strangely. `decimals` is likewise refused rather than
 * defaulted — a wrong decimals silently misstates every figure the member is shown.
 */
export function memberCurrencyPlan(
  app?: Pick<RelyingApp, 'new_member' | 'paymentConfig'> | null,
): MemberCurrencyPlan | null {
  const cur: MemberCurrency | undefined = app?.new_member?.currency;
  const pc = app?.paymentConfig;
  if (!cur || !pc) return null;
  if (!isRealAddress(cur.asset) || !isRealAddress(pc.asset)) return null;
  if (cur.asset.toLowerCase() !== pc.asset.toLowerCase()) return null;
  if (!isRealAddress(pc.payee)) return null;
  const name = (cur.name ?? '').trim();
  if (!name) return null;
  if (!Number.isInteger(cur.decimals) || cur.decimals < 0 || cur.decimals > 36) return null;
  let initialAmount = 0n;
  if (typeof cur.initial_amount === 'string' && /^\d+$/.test(cur.initial_amount.trim())) {
    initialAmount = BigInt(cur.initial_amount.trim());
  }
  return {
    asset: cur.asset,
    name,
    plural: (cur.plural ?? '').trim() || `${name}s`,
    decimals: cur.decimals,
    // Seeding needs BOTH an amount and the app's out-loud "this is play money".
    initialAmount: cur.faucet === true ? initialAmount : 0n,
    faucet: cur.faucet === true,
    spendGrant: cur.spend_grant === true,
    payee: pc.payee,
    redeemer: mandateDelegate(pc),
    caps: {
      maxAmountPerCharge: pc.maxAmountPerCharge,
      maxAggregate: pc.maxAggregate,
      ...(pc.maxRedemptionsPerWindow !== undefined ? { maxRedemptionsPerWindow: pc.maxRedemptionsPerWindow } : {}),
      ...(pc.windowSeconds !== undefined ? { windowSeconds: pc.windowSeconds } : {}),
    },
  };
}

/**
 * WHO MAY PRESENT A PAYMENT MANDATE — the one place that question is answered.
 *
 * `mode` says WHEN money moves; it was also deciding WHO may collect it, because the delegate was
 * derived from `mode` alone (`pull ? payee : OPEN`). An app whose collecting account is not its
 * redeeming account — a card room, whose coin lands in the house treasury but whose SERVICE AGENT
 * holds the key that presents the mandate — could say neither thing truthfully: naming the service
 * agent as payee sends the money to the wrong account, and leaving the payee as delegate mints a
 * mandate nobody can redeem.
 *
 * `null` means OPEN (anyone holding the mandate may present it), which is what `push` has always
 * minted and must keep minting — an x402 reader redeems at access time and is not known in advance.
 * `redeemer` is ignored there for that reason; on `pull` it defaults to the payee, so EVERY existing
 * registry entry gets exactly the delegate it got before this function existed.
 */
export function mandateDelegate(
  pc?: Pick<NonNullable<RelyingApp['paymentConfig']>, 'payee' | 'mode' | 'redeemer'> | null,
): `0x${string}` | null {
  if (!pc) return null;
  if (pc.mode !== 'pull') return null; // push ⇒ OPEN, by construction
  return isRealAddress(pc.redeemer) ? pc.redeemer : pc.payee;
}

/** Does this app want its spend mandate minted in the PLAIN sign-in, rather than in a payment-template
 *  ceremony of its own? The gate the three connect surfaces add to `isPaymentTemplate`. */
export function grantsCoinAtConnect(app?: Pick<RelyingApp, 'new_member' | 'paymentConfig'> | null): boolean {
  return memberCurrencyPlan(app)?.spendGrant === true;
}

/**
 * An atomic-unit amount as a person reads it: "10,000", "1.5", "0.06".
 *
 * Pure string arithmetic, never a float — `Number(10000e18)` loses the number, and an amount shown to
 * someone before they approve it is the last place to be approximately right. Trailing zeros in the
 * fraction are dropped, because "200.000000 Sheqel" reads like machine output and "200" reads like
 * money. Grouping is the ASCII comma rather than `toLocaleString`, so the string is identical on the
 * server render and in the browser (a hydration mismatch here would flash a DIFFERENT amount at the
 * member than the one they end up approving).
 */
export function formatCoin(atomic: bigint, decimals: number): string {
  const neg = atomic < 0n;
  const abs = neg ? -atomic : atomic;
  const unit = 10n ** BigInt(Math.max(0, decimals));
  const whole = (abs / unit).toString();
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = decimals > 0 ? (abs % unit).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

/** "10,000 Sheqels" / "1 Sheqel" — the amount and the coin's own word for itself, agreeing on number.
 *  One function so the setup screen, the consent list and any receipt cannot word it three ways. */
export function coinAmount(plan: Pick<MemberCurrencyPlan, 'name' | 'plural' | 'decimals'>, atomic: bigint): string {
  const n = formatCoin(atomic, plan.decimals);
  return `${n} ${n === '1' ? plan.name : plan.plural}`;
}

/**
 * THE SEEDING DECISION — asked of the member's BALANCE, not of their history.
 *
 * "Has this member been given their opening coin" has no honest answer from a session: a returning
 * member, a resumed ceremony and a double-invoked effect are indistinguishable, and the Home keeps no
 * ledger of who it has seeded. The chain does hold one fact that is both true and cheap: whether the
 * account holds any of this coin. So the rule is "an account with none of it gets the opening
 * amount", which makes running this twice indistinguishable from running it once — the same
 * subtractive shape as {@link newMemberWork}, for the same reason.
 *
 * WHAT THAT MEANS, SAID OUT LOUD: a member who spends every last coin and comes back is seeded again.
 * For play money that is the intended reading — a busted player can sit down again, which is what a
 * demo card room wants — and it is bounded by the two gates that make seeding possible at all: the
 * app must have declared the coin a faucet, and the token must actually be open-mint. It is NOT a
 * once-per-member guarantee, and if one is ever wanted it needs a marker the Home writes (the
 * member's own vault profile is where it would go), not a cleverer reading of a balance.
 *
 * `null` (the balance could not be read) FAILS CLOSED to "do not seed" — an unreadable balance is not
 * evidence of an empty account, and the cost of guessing wrong is minting coin into an account that
 * already had some.
 */
export function shouldSeedCoin(plan: MemberCurrencyPlan | null, balance: bigint | null): boolean {
  if (!plan || plan.initialAmount <= 0n) return false;
  return balance !== null && balance === 0n;
}

/**
 * The consent line for the spend grant, folded into the template's can/cannot list.
 *
 * WHY IT BELONGS AT CONSENT AND NOT ONLY ON THE SETUP SCREEN. The setup screen is shown to a member
 * who is being GIVEN an account right now; a returning member never sees it, and the mandate is
 * minted for them too. Consent is the one screen every connect passes through, so that is where the
 * ceiling has to be readable. Returns the template UNCHANGED for every app without a currency, so no
 * other app's consent copy moves by a character.
 *
 * The register is the one the rest of onboarding uses: what happens to your money, in words a person
 * uses about money. No "delegation", no "caveat", no "Smart Agent".
 */
export function withCurrencyConsent<T extends { canDo: string[]; cannotDo: string[] }>(
  template: T,
  app?: Pick<RelyingApp, 'new_member' | 'paymentConfig'> | null,
  appName = 'This app',
): T {
  const plan = memberCurrencyPlan(app);
  if (!plan?.spendGrant) return template;
  const lines = currencyConsentLines(plan, appName);
  if (template.canDo.includes(lines.canDo[0]!)) return template; // a re-render is not a second disclosure
  return {
    ...template,
    canDo: [...template.canDo, ...lines.canDo],
    cannotDo: [...template.cannotDo, ...lines.cannotDo],
  };
}

/** The can/cannot pair for a currency plan. Split out from {@link withCurrencyConsent} so the setup
 *  screen can show the SAME sentences it will show at consent a moment later. */
export function currencyConsentLines(plan: MemberCurrencyPlan, appName: string): { canDo: string[]; cannotDo: string[] } {
  const per = coinAmount(plan, BigInt(plan.caps.maxAmountPerCharge));
  const total = coinAmount(plan, BigInt(plan.caps.maxAggregate));
  const window = windowWords(plan.caps.windowSeconds);
  const times = plan.caps.maxRedemptionsPerWindow;
  const rate = times ? `, and at most ${times} time${times === 1 ? '' : 's'} ${window}` : '';
  return {
    canDo: [
      `Take up to ${per} from your money account at a time — no more than ${total} in total${rate}`,
    ],
    cannotDo: [
      `Take more than that, or take anything from your account that isn’t ${plan.plural}`,
      'Keep taking it once you stop them — you can end this whenever you like',
    ],
  };
}

/** "a day" / "an hour" / "in a 20-minute window" — a duration as a person says it. Bare seconds in a
 *  sentence about money is the kind of precision that reads as evasion. */
export function windowWords(seconds?: number): string {
  if (!seconds || seconds <= 0) return 'in total';
  if (seconds === 86400) return 'a day';
  if (seconds === 3600) return 'an hour';
  if (seconds % 86400 === 0) return `every ${seconds / 86400} days`;
  if (seconds % 3600 === 0) return `every ${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `every ${seconds / 60} minutes`;
  return `every ${seconds} seconds`;
}

/** The payment leg `givePermission` takes, for the first-connect spend grant. Deliberately the SAME
 *  shape the x402 / buy-in ceremonies build — this is the existing mandate, minted at a different
 *  moment, not a second kind of grant. */
export interface CoinMandateLeg {
  treasury: `0x${string}`;
  payee: `0x${string}`;
  asset: `0x${string}`;
  maxAmountPerCharge: bigint;
  maxAggregate: bigint;
  maxRedemptionsPerWindow?: number;
  windowSeconds?: number;
  mode?: 'push' | 'pull';
  redeemer?: `0x${string}`;
}

/**
 * The spend mandate an app's declared currency asks for, ready to hand to `givePermission`.
 *
 * ONE BUILDER FOR THE THREE CONNECT SURFACES. A relying-app connect lands in `RecognizedEnroll`, in
 * `OnboardingJourney` or in `GoogleEnrollResume` depending on which credential the member arrived
 * with, and each of them assembles its own payment leg today — three copies of the same twenty
 * lines, which is exactly how the Google resume path spent months silently skipping the charge.
 * Nothing about "what mandate does this app's currency ask for" depends on which of those three the
 * member walked through, so it is answered once, here, and tested.
 *
 * IT MOVES NO MONEY. No `chargeNow`, no `chargeAmount`, no `subscription` — this is a CEILING the
 * member authorises during sign-in, and the app spends against it later when the member actually
 * does something. A ceremony that charged at approval would take the coin for nothing.
 *
 * `null` for every app without a currency, without `spend_grant`, or for a member with no account to
 * mint from — in all three cases the connect proceeds with no payment leg at all, exactly as it does
 * today for an app that declares nothing.
 */
export function coinMandateLeg(
  app: Pick<RelyingApp, 'new_member' | 'paymentConfig'> | null | undefined,
  treasury: `0x${string}` | null | undefined,
): CoinMandateLeg | null {
  const plan = memberCurrencyPlan(app);
  if (!plan?.spendGrant || !treasury) return null;
  return {
    treasury,
    payee: plan.payee,
    asset: plan.asset,
    maxAmountPerCharge: BigInt(plan.caps.maxAmountPerCharge),
    maxAggregate: BigInt(plan.caps.maxAggregate),
    ...(plan.caps.maxRedemptionsPerWindow !== undefined ? { maxRedemptionsPerWindow: plan.caps.maxRedemptionsPerWindow } : {}),
    ...(plan.caps.windowSeconds !== undefined ? { windowSeconds: plan.caps.windowSeconds } : {}),
    mode: app?.paymentConfig?.mode,
    ...(plan.redeemer ? { redeemer: plan.redeemer } : {}),
  };
}
