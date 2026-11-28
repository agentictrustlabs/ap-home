import { describe, it, expect } from 'vitest';
import { accept, assembleRoster, cancel, householdNameOf, invite, parsePageRequest, viewOf, withSteward, StewardInvitationError, type StewardInvitation } from './household-steward-invitation';

const ORG = '0x' + '1'.repeat(40), A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
const wire = (to: string, sig = '0xs') => ({ delegator: ORG, delegate: to, signature: sig, caveats: [] });
const yes = async () => true, no = async () => false;
const APPS = [{ client_id: 'family-field', name: 'Family Field', redirect_uris: ['https://ap-family.faithnet.io/'], steward_invitations: true }, { client_id: 'other', redirect_uris: ['https://x.test/'] }];
const err = async (p: Promise<unknown> | (() => unknown)) => { try { await (typeof p === 'function' ? p() : p); } catch (e) { return (e as StewardInvitationError).code; } return 'none'; };

describe('the page request', () => {
  it('reads an invite and an accept, for an app registered for steward invitations', () => {
    expect(parsePageRequest(`?household=${ORG}&person=${B}&name=Barbara&from=family-field&return=https://ap-family.faithnet.io/`, APPS)).toEqual({ ok: true, request: { mode: 'invite', household: ORG, person: B, label: 'Barbara', appName: 'Family Field', returnTo: 'https://ap-family.faithnet.io/' } });
    expect(parsePageRequest(`?action=accept&household=${ORG}&member=${B}&from=family-field&return=https://ap-family.faithnet.io/`, APPS)).toMatchObject({ ok: true, request: { mode: 'accept', member: B } });
  });
  it('carries the household\'s name the app passes, and ignores one that is not a name', () => {
    const q = (n: string) => parsePageRequest(`?household=${ORG}&person=${B}&name=Barbara&householdName=${encodeURIComponent(n)}&from=family-field&return=https://ap-family.faithnet.io/`, APPS);
    expect(q('The Meadow family')).toMatchObject({ ok: true, request: { householdName: 'The Meadow family' } });
    expect(parsePageRequest(`?action=accept&household=${ORG}&householdName=The%20Meadows&from=family-field&return=https://ap-family.faithnet.io/`, APPS)).toMatchObject({ ok: true, request: { mode: 'accept', householdName: 'The Meadows' } });
    for (const bad of [ORG, 'x'.repeat(61), 'a\u0007b', '   ']) {
      const r = q(bad);
      expect(r.ok).toBe(true);
      expect((r as { request: object }).request).not.toHaveProperty('householdName');
    }
    expect(householdNameOf('  The   Meadow  family ')).toBe('The Meadow family');
  });
  it('refuses an app not registered for it, a foreign return, a bad address', () => {
    expect(parsePageRequest(`?household=${ORG}&person=${B}&from=other&return=https://x.test/`, APPS).ok).toBe(false);
    expect(parsePageRequest(`?household=${ORG}&person=${B}&from=family-field&return=https://evil.test/`, APPS).ok).toBe(false);
    expect(parsePageRequest(`?household=nope&person=${B}&from=family-field&return=https://ap-family.faithnet.io/`, APPS).ok).toBe(false);
    expect(parsePageRequest(`?household=${ORG}&from=family-field&return=https://ap-family.faithnet.io/`, APPS).ok).toBe(false);
  });
});

describe('invite → accept → cancel', () => {
  const base = { org: ORG, caller: A, invitee: B, label: 'Barbara', delegation: wire(B), callerIsSteward: true, alreadySteward: false, existing: null, now: 1, verify: yes };
  it('a steward invites with the household’s live grant to the invitee', async () => {
    const inv = await invite(base);
    expect(inv).toMatchObject({ org: ORG, invitee: B, invitedBy: A, state: 'pending', label: 'Barbara' });
    expect(viewOf(inv)).not.toHaveProperty('delegation');
  });
  it('refuses a non-steward, oneself, an existing steward, and a wire that is not the household’s grant to them', async () => {
    expect(await err(invite({ ...base, callerIsSteward: false }))).toBe('not_a_steward');
    expect(await err(invite({ ...base, invitee: A, delegation: wire(A) }))).toBe('invalid_request');
    expect(await err(invite({ ...base, alreadySteward: true }))).toBe('already_steward');
    expect(await err(invite({ ...base, delegation: wire(C) }))).toBe('not_a_stewardship_grant');
    expect(await err(invite({ ...base, verify: no }))).toBe('not_a_stewardship_grant');
  });
  it('the invitee accepts while the grant verifies; not someone else, not after it lapsed', async () => {
    const inv = await invite(base);
    expect(await accept({ caller: B, invitation: inv, now: 2, verify: yes })).toMatchObject({ state: 'accepted', acceptedAt: 2 });
    expect(await err(accept({ caller: C, invitation: inv, now: 2, verify: yes }))).toBe('no_invitation');
    expect(await err(accept({ caller: B, invitation: inv, now: 2, verify: no }))).toBe('invitation_lapsed');
    expect(await err(accept({ caller: B, invitation: cancel({ callerIsSteward: true, invitation: inv, now: 3 }), now: 4, verify: yes }))).toBe('no_invitation');
  });
  it('a pending invitation can be cancelled; an accepted one needs the grant revoked, said, not faked', async () => {
    const inv = await invite(base);
    expect(cancel({ callerIsSteward: true, invitation: inv, now: 3 }).state).toBe('cancelled');
    const accepted: StewardInvitation = { ...inv, state: 'accepted' };
    expect(await err(() => cancel({ callerIsSteward: true, invitation: accepted, now: 3 }))).toBe('revoke_required');
    expect(await err(() => cancel({ callerIsSteward: false, invitation: inv, now: 3 }))).toBe('not_a_steward');
  });
});

describe('the roster', () => {
  it('lists verified stewards, members apart from them, and lapsed grants as not stewards', async () => {
    const verify = async (_o: string, p: string) => p !== C;
    const r = await assembleRoster({ org: ORG, you: 'steward', verify, members: [B, A, 'bad'],
      stewards: [{ agent: A, delegation: wire(A), since: 1, via: 'founder' }, { agent: C, delegation: wire(C), since: 2, via: 'invitation' }], invitations: [] });
    expect(r.people).toEqual([{ agent: A, relationship: 'steward', verified: true, via: 'stewardship-wire', since: 1 }, { agent: B, relationship: 'member', verified: false, via: 'membership' }]);
    expect(r.lapsed).toEqual([C]);
  });
  it('withSteward adds once and keeps since/via on a re-issued grant', () => {
    const one = withSteward([], { agent: A, delegation: wire(A, '0x1'), since: 1, via: 'founder' });
    expect(withSteward(one, { agent: A, delegation: wire(A, '0x1'), since: 9, via: 'invitation' })).toBe(one);
    expect(withSteward(one, { agent: A, delegation: wire(A, '0x2'), since: 9, via: 'invitation' })[0]).toMatchObject({ since: 1, via: 'founder', delegation: { signature: '0x2' } });
  });
});
