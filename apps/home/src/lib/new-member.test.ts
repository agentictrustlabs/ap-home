import { describe, expect, it } from 'vitest';
import {
  NO_NEW_MEMBER,
  coinAmount,
  coinMandateLeg,
  currencyConsentLines,
  formatCoin,
  grantsCoinAtConnect,
  mandateDelegate,
  memberCurrencyPlan,
  shouldSeedCoin,
  windowWords,
  withCurrencyConsent,
  isNewHomeMoment,
  newMemberPlan,
  nameClaimForIdToken,
  newMemberWork,
  personDisplayName,
  planIsEmpty,
  sharesProfileName,
  splitPersonName,
  withProfileNameConsent,
  workIsEmpty,
} from './new-member';
import { whitelabel } from '../whitelabel/config';

// The safety property the whole feature rests on: an app that declares nothing gets nothing. These
// are the assertions that would fail if someone made first-connect provisioning a platform default.
describe('newMemberPlan — absent config means today’s behaviour', () => {
  it('returns the empty plan for undefined / null / no field', () => {
    expect(newMemberPlan(undefined)).toEqual(NO_NEW_MEMBER);
    expect(newMemberPlan(null)).toEqual(NO_NEW_MEMBER);
    expect(newMemberPlan({})).toEqual(NO_NEW_MEMBER);
  });

  it('returns the empty plan for an empty declaration', () => {
    expect(newMemberPlan({ new_member: {} })).toEqual(NO_NEW_MEMBER);
    expect(planIsEmpty(newMemberPlan({ new_member: {} }))).toBe(true);
  });

  it('never turns anything on by accident — only literal true / known values count', () => {
    // A hand-edited config with a truthy-but-wrong value must not silently provision.
    expect(newMemberPlan({ new_member: { personal_treasury: undefined } }).treasury).toBe(false);
    expect(newMemberPlan({ new_member: { collect_name: undefined } }).name).toBe('off');
    expect(newMemberPlan({ new_member: { collect_name: 'yes' as never } }).name).toBe('off');
  });

  it('reads what an app did declare', () => {
    expect(newMemberPlan({ new_member: { personal_treasury: true, collect_name: 'required' } }))
      .toEqual({ treasury: true, name: 'required', currency: null });
    expect(newMemberPlan({ new_member: { collect_name: 'optional' } }))
      .toEqual({ treasury: false, name: 'optional', currency: null });
  });

  // The registry itself, not a fixture: if someone adds `new_member` to another app, this fails and
  // makes them say so out loud.
  it('is declared by exactly one app in the live registry, and that app is pokernight', () => {
    const declared = whitelabel.relyingApps.filter((a) => !planIsEmpty(newMemberPlan(a)));
    expect(declared.map((a) => a.client_id)).toEqual(['pokernight']);
    // …and its CURRENCY is still off, because the Sheqel token is a documented placeholder (the
    // zero address). This is the assertion that guarantees the live site behaves today exactly as it
    // did before the app-coin capability existed — and the one that will fail, on purpose, the day
    // someone fills the address in without meaning to turn it on.
    expect(newMemberPlan(declared[0])).toEqual({ treasury: true, name: 'required', currency: null });
  });

  it('leaves every other registered app on the empty plan', () => {
    for (const app of whitelabel.relyingApps) {
      if (app.client_id === 'pokernight') continue;
      expect(newMemberPlan(app), app.client_id).toEqual(NO_NEW_MEMBER);
    }
  });
});

describe('newMemberWork — idempotence', () => {
  const plan = { treasury: true, name: 'required', currency: null } as const;

  it('does the work when the member has neither', () => {
    expect(newMemberWork(plan, { hasTreasury: false, hasProfileName: false }))
      .toEqual({ treasury: true, name: true, seed: false });
  });

  it('never creates a second treasury for a member who already has one', () => {
    expect(newMemberWork(plan, { hasTreasury: true, hasProfileName: false }).treasury).toBe(false);
  });

  it('never re-asks a member who already has a name', () => {
    expect(newMemberWork(plan, { hasTreasury: false, hasProfileName: true }).name).toBe(false);
  });

  it('is a no-op for a returning member — the resumed-ceremony / double-effect case', () => {
    const work = newMemberWork(plan, { hasTreasury: true, hasProfileName: true });
    expect(work).toEqual({ treasury: false, name: false, seed: false });
    expect(workIsEmpty(work)).toBe(true);
  });

  it('is subtractive, so running it twice equals running it once', () => {
    const first = newMemberWork(plan, { hasTreasury: false, hasProfileName: false });
    expect(first).toEqual({ treasury: true, name: true, seed: false });
    // …the effects land, the state changes, and the second pass asks for nothing.
    const second = newMemberWork(plan, { hasTreasury: true, hasProfileName: true });
    expect(workIsEmpty(second)).toBe(true);
  });

  it('asks for nothing at all when the app declared nothing, whatever the member has', () => {
    for (const hasTreasury of [true, false]) {
      for (const hasProfileName of [true, false]) {
        expect(workIsEmpty(newMemberWork(NO_NEW_MEMBER, { hasTreasury, hasProfileName }))).toBe(true);
      }
    }
  });
});

describe('isNewHomeMoment — only a genuinely new home', () => {
  const newHome = { deployed: true, hasSession: true, linkingCredential: false };

  it('accepts a deployed home with a session that is not a link', () => {
    expect(isNewHomeMoment(newHome)).toBe(true);
  });

  it('refuses the link / facet path outright (adding a phone or email to an existing account)', () => {
    expect(isNewHomeMoment({ ...newHome, linkingCredential: true })).toBe(false);
  });

  it('refuses before the person’s own agent is on chain — nothing can be parented to it yet', () => {
    expect(isNewHomeMoment({ ...newHome, deployed: false })).toBe(false);
  });

  it('refuses without a session to sign with', () => {
    expect(isNewHomeMoment({ ...newHome, hasSession: false })).toBe(false);
  });

  it('refuses on every combination that is missing anything', () => {
    expect(isNewHomeMoment({ deployed: false, hasSession: false, linkingCredential: false })).toBe(false);
    expect(isNewHomeMoment({ deployed: true, hasSession: false, linkingCredential: true })).toBe(false);
    expect(isNewHomeMoment({ deployed: false, hasSession: true, linkingCredential: true })).toBe(false);
  });
});

describe('splitPersonName / personDisplayName', () => {
  it('treats one word as a first name (a mononym is a real name)', () => {
    expect(splitPersonName('Rich')).toEqual({ firstName: 'Rich', lastName: '' });
  });

  it('keeps every part after the first space as the last name', () => {
    expect(splitPersonName('Mary Anne Evans')).toEqual({ firstName: 'Mary', lastName: 'Anne Evans' });
  });

  it('collapses stray whitespace instead of writing it into the profile', () => {
    expect(splitPersonName('  Rich   Pedersen  ')).toEqual({ firstName: 'Rich', lastName: 'Pedersen' });
  });

  it('returns nothing for blank input, so a blank is never written over a profile', () => {
    expect(splitPersonName('   ')).toEqual({ firstName: '', lastName: '' });
    expect(splitPersonName('')).toEqual({ firstName: '', lastName: '' });
  });

  it('caps the length rather than letting a paste become someone’s name', () => {
    expect(splitPersonName('a'.repeat(200)).firstName).toHaveLength(80);
  });

  it('round-trips through the profile shape', () => {
    const { firstName, lastName } = splitPersonName('Rich Pedersen');
    expect(personDisplayName({ firstName, lastName })).toBe('Rich Pedersen');
  });

  it('reports no name for an empty / absent profile — the "shows as an address" case', () => {
    expect(personDisplayName(undefined)).toBe('');
    expect(personDisplayName(null)).toBe('');
    expect(personDisplayName({})).toBe('');
    expect(personDisplayName({ firstName: '  ' })).toBe('');
  });

  it('counts a first name alone as having a name', () => {
    expect(personDisplayName({ firstName: 'Rich' })).toBe('Rich');
  });
});

describe('profile-name sharing is registry-gated', () => {
  it('is off for an app without the scope, and for an unknown client', () => {
    expect(sharesProfileName(undefined)).toBe(false);
    expect(sharesProfileName({ allowed_scopes: ['openid', 'agent'] })).toBe(false);
  });

  it('is on only for an app the registry permits', () => {
    expect(sharesProfileName({ allowed_scopes: ['openid', 'profile', 'agent'] })).toBe(true);
  });

  it('is declared by pokernight and by no one else in the live registry', () => {
    const scoped = whitelabel.relyingApps.filter(sharesProfileName).map((a) => a.client_id);
    expect(scoped).toEqual(['pokernight']);
  });

  it('leaves consent copy untouched for every app without the scope', () => {
    const tpl = { canDo: ['Sign in as you'], cannotDo: ['Move your funds'] };
    expect(withProfileNameConsent(tpl, { allowed_scopes: ['openid', 'agent'] })).toBe(tpl);
  });

  it('discloses the name for an app that will receive it, without dropping the existing lines', () => {
    const tpl = { canDo: ['Sign in as you'], cannotDo: ['Move your funds'] };
    const out = withProfileNameConsent(tpl, { allowed_scopes: ['openid', 'profile'] });
    expect(out.canDo[0]).toBe('Sign in as you');
    expect(out.canDo).toHaveLength(2);
    expect(out.canDo[1]).toMatch(/name you go by/);
    expect(out.cannotDo).toEqual(tpl.cannotDo);
  });

  it('puts the handle on the id_token claim whenever there is one', () => {
    expect(nameClaimForIdToken('rich.me', 'Rich Pedersen')).toBe('rich.me');
  });

  it('falls back to the human name only for a NAMELESS account — the truncated-address case', () => {
    expect(nameClaimForIdToken('', 'Rich Pedersen')).toBe('Rich Pedersen');
    expect(nameClaimForIdToken(undefined, 'Rich Pedersen')).toBe('Rich Pedersen');
  });

  it('leaves the claim absent when there is neither, exactly as today', () => {
    expect(nameClaimForIdToken('', '')).toBeUndefined();
    expect(nameClaimForIdToken(undefined, undefined)).toBeUndefined();
    expect(nameClaimForIdToken('  ', '  ')).toBeUndefined();
  });

  it('does not stack the line when applied twice (a re-render is not a second disclosure)', () => {
    const app = { allowed_scopes: ['profile'] };
    const once = withProfileNameConsent({ canDo: [], cannotDo: ['x'] }, app);
    expect(withProfileNameConsent(once, app).canDo).toHaveLength(1);
  });
});

// ── The app's own coin ────────────────────────────────────────────────────────────────────────
//
// Same three properties the rest of this file asserts, asked of the currency: an app that declared
// nothing gets nothing, a member who already has it is not given it twice, and the live registry is
// held to both.

const SHEQEL = '0x1111111111111111111111111111111111111111' as const;
const HOUSE = '0x2222222222222222222222222222222222222222' as const;
const SERVICE = '0x3333333333333333333333333333333333333333' as const;

/** A fully-configured app coin — the shape pokernight takes once the token is deployed. */
const cardRoom = {
  paymentConfig: {
    payee: HOUSE,
    asset: SHEQEL,
    maxAmountPerCharge: '200000000',
    maxAggregate: '1000000000',
    maxRedemptionsPerWindow: 5,
    windowSeconds: 86400,
    mode: 'pull' as const,
    redeemer: SERVICE,
  },
  new_member: {
    personal_treasury: true,
    collect_name: 'required' as const,
    currency: {
      asset: SHEQEL,
      name: 'Sheqel',
      plural: 'Sheqels',
      decimals: 6,
      initial_amount: '10000000000',
      faucet: true,
      spend_grant: true,
    },
  },
};

describe('memberCurrencyPlan — absent or half-written config means today’s behaviour', () => {
  it('is null for an app that declared nothing', () => {
    expect(memberCurrencyPlan(undefined)).toBeNull();
    expect(memberCurrencyPlan(null)).toBeNull();
    expect(memberCurrencyPlan({})).toBeNull();
    expect(memberCurrencyPlan({ new_member: { personal_treasury: true } })).toBeNull();
  });

  it('is null without a paymentConfig — there are no caps to bound a spend grant with', () => {
    expect(memberCurrencyPlan({ new_member: cardRoom.new_member })).toBeNull();
  });

  // The placeholder mechanism the pokernight entry uses while the token is being deployed.
  it('is null for the zero address — how the registry writes "not deployed yet"', () => {
    const zero = '0x0000000000000000000000000000000000000000' as const;
    expect(memberCurrencyPlan({
      ...cardRoom,
      paymentConfig: { ...cardRoom.paymentConfig, asset: zero },
      new_member: { ...cardRoom.new_member, currency: { ...cardRoom.new_member.currency, asset: zero } },
    })).toBeNull();
  });

  // The invariant. Two fields naming the coin is a real risk, so a disagreement is refused outright
  // rather than resolved in favour of one of them.
  it('REFUSES when the currency and the paymentConfig name different tokens', () => {
    expect(memberCurrencyPlan({
      ...cardRoom,
      paymentConfig: { ...cardRoom.paymentConfig, asset: '0x9999999999999999999999999999999999999999' },
    })).toBeNull();
  });

  it('refuses a nonsense decimals rather than defaulting one — a wrong figure is worse than none', () => {
    for (const decimals of [-1, 1.5, 99, NaN]) {
      expect(memberCurrencyPlan({
        ...cardRoom,
        new_member: { ...cardRoom.new_member, currency: { ...cardRoom.new_member.currency, decimals } },
      }), String(decimals)).toBeNull();
    }
  });

  it('reads a fully-configured coin', () => {
    expect(memberCurrencyPlan(cardRoom)).toEqual({
      asset: SHEQEL,
      name: 'Sheqel',
      plural: 'Sheqels',
      decimals: 6,
      initialAmount: 10_000_000_000n,
      faucet: true,
      spendGrant: true,
      payee: HOUSE,
      redeemer: SERVICE,
      caps: { maxAmountPerCharge: '200000000', maxAggregate: '1000000000', maxRedemptionsPerWindow: 5, windowSeconds: 86400 },
    });
  });

  it('derives the plural when the app didn’t give one', () => {
    const { plural } = memberCurrencyPlan({
      ...cardRoom,
      new_member: { ...cardRoom.new_member, currency: { ...cardRoom.new_member.currency, plural: undefined } },
    })!;
    expect(plural).toBe('Sheqels');
  });

  // Seeding is two switches, not one: an amount, and the app saying out loud that this is play money.
  it('will not seed a coin the app did not declare a faucet, whatever the amount says', () => {
    const plan = memberCurrencyPlan({
      ...cardRoom,
      new_member: { ...cardRoom.new_member, currency: { ...cardRoom.new_member.currency, faucet: undefined } },
    })!;
    expect(plan.initialAmount).toBe(0n);
    expect(plan.faucet).toBe(false);
  });

  it('ignores an initial_amount that is not a whole number of atomic units', () => {
    for (const initial_amount of ['10.5', '-1', '1e6', 'lots', '']) {
      const plan = memberCurrencyPlan({
        ...cardRoom,
        new_member: { ...cardRoom.new_member, currency: { ...cardRoom.new_member.currency, initial_amount } },
      })!;
      expect(plan.initialAmount, initial_amount).toBe(0n);
    }
  });

  it('only mints the spend mandate at connect when the app asked for it', () => {
    expect(grantsCoinAtConnect(cardRoom)).toBe(true);
    expect(grantsCoinAtConnect({
      ...cardRoom,
      new_member: { ...cardRoom.new_member, currency: { ...cardRoom.new_member.currency, spend_grant: undefined } },
    })).toBe(false);
    expect(grantsCoinAtConnect(undefined)).toBe(false);
  });

  // The live registry, not a fixture — the same guarantee the `new_member` block above asserts.
  it('is declared by no app in the live registry today (the Sheqel token is a placeholder)', () => {
    const withCoin = whitelabel.relyingApps.filter((a) => memberCurrencyPlan(a) !== null);
    expect(withCoin.map((a) => a.client_id)).toEqual([]);
  });

  it('leaves every live app on today’s connect — no spend mandate rides any plain sign-in', () => {
    for (const app of whitelabel.relyingApps) {
      expect(grantsCoinAtConnect(app), app.client_id).toBe(false);
      expect(coinMandateLeg(app, HOUSE), app.client_id).toBeNull();
    }
  });
});

describe('mandateDelegate — WHO may present a mandate, separately from WHEN money moves', () => {
  it('is OPEN for push, whatever a redeemer says — an x402 reader is not known in advance', () => {
    expect(mandateDelegate({ payee: HOUSE, mode: 'push' })).toBeNull();
    expect(mandateDelegate({ payee: HOUSE, mode: 'push', redeemer: SERVICE })).toBeNull();
    expect(mandateDelegate({ payee: HOUSE })).toBeNull(); // mode defaults to push
  });

  // The regression guard for every entry written before `redeemer` existed.
  it('is the payee for pull with no redeemer — byte-identical to the old behaviour', () => {
    expect(mandateDelegate({ payee: HOUSE, mode: 'pull' })).toBe(HOUSE);
    expect(mandateDelegate({ payee: HOUSE, mode: 'pull', redeemer: undefined })).toBe(HOUSE);
    expect(mandateDelegate({ payee: HOUSE, mode: 'pull', redeemer: '0x0000000000000000000000000000000000000000' })).toBe(HOUSE);
  });

  it('is the service agent when one is declared — the collecting account is not the redeeming one', () => {
    expect(mandateDelegate({ payee: HOUSE, mode: 'pull', redeemer: SERVICE })).toBe(SERVICE);
  });

  it('leaves every live registry entry’s delegate exactly where it was', () => {
    for (const app of whitelabel.relyingApps) {
      const pc = app.paymentConfig;
      if (!pc) continue;
      expect(mandateDelegate(pc), app.client_id).toBe(pc.mode === 'pull' ? pc.payee : null);
    }
  });
});

describe('shouldSeedCoin / newMemberWork.seed — idempotence, from the balance', () => {
  const plan = memberCurrencyPlan(cardRoom)!;

  it('seeds an account holding none of the coin', () => {
    expect(shouldSeedCoin(plan, 0n)).toBe(true);
  });

  it('never seeds an account that already holds some — the returning-member case', () => {
    expect(shouldSeedCoin(plan, 1n)).toBe(false);
    expect(shouldSeedCoin(plan, plan.initialAmount)).toBe(false);
  });

  it('fails closed on an unreadable balance — not knowing is not evidence of an empty account', () => {
    expect(shouldSeedCoin(plan, null)).toBe(false);
  });

  it('does nothing for an app with no coin, or a coin with no opening amount', () => {
    expect(shouldSeedCoin(null, 0n)).toBe(false);
    expect(shouldSeedCoin({ ...plan, initialAmount: 0n }, 0n)).toBe(false);
  });

  it('is subtractive, so running it twice equals running it once', () => {
    const full = { treasury: true, name: 'required' as const, currency: plan };
    // First pass: no account at all ⇒ open one and put the opening amount in it.
    const first = newMemberWork(full, { hasTreasury: false, hasProfileName: false, coinBalance: null });
    expect(first).toEqual({ treasury: true, name: true, seed: true });
    // The effects land. Second pass: an account, with coin in it, and a name ⇒ nothing.
    const second = newMemberWork(full, { hasTreasury: true, hasProfileName: true, coinBalance: plan.initialAmount });
    expect(workIsEmpty(second)).toBe(true);
  });

  it('seeds a member who had an account BEFORE this app existed and holds none of its coin', () => {
    const full = { treasury: true, name: 'required' as const, currency: plan };
    expect(newMemberWork(full, { hasTreasury: true, hasProfileName: true, coinBalance: 0n }))
      .toEqual({ treasury: false, name: false, seed: true });
  });

  it('treats an account we are about to create as empty without needing a balance read', () => {
    const full = { treasury: true, name: 'off' as const, currency: plan };
    expect(newMemberWork(full, { hasTreasury: false, hasProfileName: true }).seed).toBe(true);
  });

  it('asks for nothing at all when the app declared no coin, whatever the balance', () => {
    for (const coinBalance of [null, 0n, 5n]) {
      const w = newMemberWork(NO_NEW_MEMBER, { hasTreasury: false, hasProfileName: false, coinBalance });
      expect(workIsEmpty(w)).toBe(true);
    }
  });
});

describe('coinMandateLeg — the existing payment mandate, minted in the first connect', () => {
  const TREASURY = '0x4444444444444444444444444444444444444444' as const;

  it('is the paymentConfig caps, over the declared coin, redeemable by the service agent', () => {
    expect(coinMandateLeg(cardRoom, TREASURY)).toEqual({
      treasury: TREASURY,
      payee: HOUSE,
      asset: SHEQEL,
      maxAmountPerCharge: 200_000_000n,
      maxAggregate: 1_000_000_000n,
      maxRedemptionsPerWindow: 5,
      windowSeconds: 86400,
      mode: 'pull',
      redeemer: SERVICE,
    });
  });

  // The thing that must never be true of a grant minted during sign-in.
  it('carries nothing that moves money — no charge, no amount, no subscription', () => {
    const leg = coinMandateLeg(cardRoom, TREASURY)!;
    expect(leg).not.toHaveProperty('chargeNow');
    expect(leg).not.toHaveProperty('chargeAmount');
    expect(leg).not.toHaveProperty('subscription');
  });

  it('is null for a member with no account to mint from', () => {
    expect(coinMandateLeg(cardRoom, null)).toBeNull();
    expect(coinMandateLeg(cardRoom, undefined)).toBeNull();
  });

  it('is null for an app that did not ask for the grant at connect', () => {
    expect(coinMandateLeg({
      ...cardRoom,
      new_member: { ...cardRoom.new_member, currency: { ...cardRoom.new_member.currency, spend_grant: undefined } },
    }, TREASURY)).toBeNull();
  });
});

describe('formatCoin / coinAmount — the figure the member reads', () => {
  it('groups thousands and drops a zero fraction', () => {
    expect(formatCoin(10_000_000_000n, 6)).toBe('10,000');
    expect(formatCoin(200_000_000n, 6)).toBe('200');
    expect(formatCoin(1_000_000n, 6)).toBe('1');
  });

  it('keeps a real fraction, without trailing zeros', () => {
    expect(formatCoin(1_500_000n, 6)).toBe('1.5');
    expect(formatCoin(60_000n, 6)).toBe('0.06');
    expect(formatCoin(1n, 6)).toBe('0.000001');
  });

  it('is exact for amounts a float would lose', () => {
    expect(formatCoin(12_345_678_901_234_567_890n, 18)).toBe('12.34567890123456789');
  });

  it('handles a zero-decimal token and zero itself', () => {
    expect(formatCoin(1234n, 0)).toBe('1,234');
    expect(formatCoin(0n, 6)).toBe('0');
  });

  it('agrees with the coin’s own word for itself, singular and plural', () => {
    const plan = memberCurrencyPlan(cardRoom)!;
    expect(coinAmount(plan, 10_000_000_000n)).toBe('10,000 Sheqels');
    expect(coinAmount(plan, 1_000_000n)).toBe('1 Sheqel');
    expect(coinAmount(plan, 0n)).toBe('0 Sheqels');
  });
});

describe('the words the member is shown before they agree', () => {
  const plan = memberCurrencyPlan(cardRoom)!;

  it('says the ceiling, the total and the rate, in the amounts a person reads', () => {
    const { canDo, cannotDo } = currencyConsentLines(plan, 'Poker Night');
    expect(canDo[0]).toBe('Take up to 200 Sheqels from your money account at a time — no more than 1,000 Sheqels in total, and at most 5 times a day');
    expect(cannotDo[0]).toContain('isn’t Sheqels');
    expect(cannotDo.some((l) => /stop them/.test(l))).toBe(true);
  });

  // The register rule: these screens are read by people signing in to a card room, not by engineers.
  it('uses no platform vocabulary anywhere in the member-facing copy', () => {
    const { canDo, cannotDo } = currencyConsentLines(plan, 'Poker Night');
    for (const line of [...canDo, ...cannotDo]) {
      expect(line, line).not.toMatch(/delegation|delegate|caveat|mandate|Smart Agent|treasury|ERC-?20|atomic/i);
    }
  });

  it('turns a window into words rather than seconds', () => {
    expect(windowWords(86400)).toBe('a day');
    expect(windowWords(3600)).toBe('an hour');
    expect(windowWords(172800)).toBe('every 2 days');
    expect(windowWords(1800)).toBe('every 30 minutes');
    expect(windowWords(undefined)).toBe('in total');
  });

  it('leaves consent copy byte-identical for every app without a coin', () => {
    const tpl = { canDo: ['Sign in as you'], cannotDo: ['Move your funds'] };
    expect(withCurrencyConsent(tpl, undefined)).toBe(tpl);
    for (const app of whitelabel.relyingApps) {
      expect(withCurrencyConsent(tpl, app), app.client_id).toBe(tpl);
    }
  });

  it('adds the disclosure for an app that will be able to move the coin', () => {
    const tpl = { canDo: ['Sign in as you'], cannotDo: ['Move your funds'] };
    const out = withCurrencyConsent(tpl, cardRoom, 'Poker Night');
    expect(out.canDo[0]).toBe('Sign in as you');
    expect(out.canDo).toHaveLength(2);
    expect(out.cannotDo[0]).toBe('Move your funds');
    expect(out.cannotDo.length).toBeGreaterThan(1);
  });

  it('does not stack the lines when applied twice (a re-render is not a second disclosure)', () => {
    const once = withCurrencyConsent({ canDo: [], cannotDo: [] }, cardRoom, 'Poker Night');
    expect(withCurrencyConsent(once, cardRoom, 'Poker Night')).toEqual(once);
  });
});
