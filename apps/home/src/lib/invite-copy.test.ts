import { describe, expect, it } from 'vitest';
import { inviteAcceptLabel, inviteEmailSubject, inviteHeadline, inviteLead } from './invite-copy';

describe('invite copy names the app when one is on the invitation', () => {
  it('leads with the app, not the org', () => {
    expect(inviteHeadline('colorado-outreach', 'Commons')).toBe("You're invited to Commons");
    expect(inviteLead('colorado-outreach', 'Commons')).toMatch(/Join colorado-outreach on Commons/);
    expect(inviteLead('colorado-outreach', 'Commons')).toMatch(/take you to Commons/);
    expect(inviteAcceptLabel('colorado-outreach', 'Commons')).toBe('Accept & join Commons');
    expect(inviteEmailSubject('colorado-outreach', 'Commons')).toBe("You're invited to Commons (colorado-outreach)");
  });

  it('stays org-only when no app was recorded', () => {
    expect(inviteHeadline('colorado-outreach', null)).toBe("You're invited to join colorado-outreach");
    expect(inviteAcceptLabel('colorado-outreach', null)).toBe('Accept & join colorado-outreach');
    expect(inviteLead('colorado-outreach', null)).not.toMatch(/Commons/);
  });
});
