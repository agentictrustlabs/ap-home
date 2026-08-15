import { describe, expect, it } from 'vitest';
import { emailInviteNeedsSignOut, invitedAgentFromGrant } from './email-invite-home';

const ALICE = '0xc35c8f17c9cbf58c20a4f4cd8bd702b8c91f532b';
const INVITEE = '0x1111111111111111111111111111111111111111';

describe('invitedAgentFromGrant', () => {
  it('reads the grant delegate', () => {
    expect(invitedAgentFromGrant({ delegate: INVITEE })).toBe(INVITEE);
  });

  it('returns null when the grant names no address', () => {
    expect(invitedAgentFromGrant(null)).toBeNull();
    expect(invitedAgentFromGrant({})).toBeNull();
    expect(invitedAgentFromGrant({ delegate: 'not-an-address' })).toBeNull();
  });
});

describe('emailInviteNeedsSignOut', () => {
  it('lets an anonymous visitor redeem the link', () => {
    expect(emailInviteNeedsSignOut(null, INVITEE)).toBe(false);
  });

  it('lets the invited home accept', () => {
    expect(emailInviteNeedsSignOut(INVITEE, INVITEE)).toBe(false);
    expect(emailInviteNeedsSignOut(INVITEE.toUpperCase(), INVITEE)).toBe(false);
  });

  it('blocks a different signed-in home', () => {
    expect(emailInviteNeedsSignOut(ALICE, INVITEE)).toBe(true);
  });

  it('blocks a signed-in home when the invitee is unknown — do not join as whoever is here', () => {
    expect(emailInviteNeedsSignOut(ALICE, null)).toBe(true);
  });
});
