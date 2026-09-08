import { describe, expect, it } from 'vitest';
import {
  NO_NEW_MEMBER,
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
      .toEqual({ treasury: true, name: 'required' });
    expect(newMemberPlan({ new_member: { collect_name: 'optional' } }))
      .toEqual({ treasury: false, name: 'optional' });
  });

  // The registry itself, not a fixture: if someone adds `new_member` to another app, this fails and
  // makes them say so out loud.
  it('is declared by exactly one app in the live registry, and that app is pokernight', () => {
    const declared = whitelabel.relyingApps.filter((a) => !planIsEmpty(newMemberPlan(a)));
    expect(declared.map((a) => a.client_id)).toEqual(['pokernight']);
    expect(newMemberPlan(declared[0])).toEqual({ treasury: true, name: 'required' });
  });

  it('leaves every other registered app on the empty plan', () => {
    for (const app of whitelabel.relyingApps) {
      if (app.client_id === 'pokernight') continue;
      expect(newMemberPlan(app), app.client_id).toEqual(NO_NEW_MEMBER);
    }
  });
});

describe('newMemberWork — idempotence', () => {
  const plan = { treasury: true, name: 'required' } as const;

  it('does the work when the member has neither', () => {
    expect(newMemberWork(plan, { hasTreasury: false, hasProfileName: false }))
      .toEqual({ treasury: true, name: true });
  });

  it('never creates a second treasury for a member who already has one', () => {
    expect(newMemberWork(plan, { hasTreasury: true, hasProfileName: false }).treasury).toBe(false);
  });

  it('never re-asks a member who already has a name', () => {
    expect(newMemberWork(plan, { hasTreasury: false, hasProfileName: true }).name).toBe(false);
  });

  it('is a no-op for a returning member — the resumed-ceremony / double-effect case', () => {
    const work = newMemberWork(plan, { hasTreasury: true, hasProfileName: true });
    expect(work).toEqual({ treasury: false, name: false });
    expect(workIsEmpty(work)).toBe(true);
  });

  it('is subtractive, so running it twice equals running it once', () => {
    const first = newMemberWork(plan, { hasTreasury: false, hasProfileName: false });
    expect(first).toEqual({ treasury: true, name: true });
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
