// Spec 421 — accepting an invitation by asking: only one that reached her inbox; her Home runs the Join ceremony; joined is
// what HER records then say, never what the surface claims.
import { describe, expect, it } from 'vitest';
import { isInputRequired } from '@agenticprimitives/orchestration';
import { membershipAcceptInvoker } from '../src/invitations-received.js';

const ME = '0x1dba4a27c53d7babda99513080223fb3bfc4bad1', ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333', OTHER = '0x' + 'ab'.repeat(20);
const inboxWith = (org: string) => ({ envelopes: [{ id: 'm1', from: `eip155:34348:0x${'a1'.repeat(20)}`, createdAt: '2026-09-29T10:00:00Z', contextRefs: [{ kind: 'org-channels', id: org, label: 'Missio Nexus' }] }] });
const deps = (joined: () => boolean) => ({
  readSubjectRecord: async (_s: string, r: string) => (r === 'inbox.data' ? inboxWith(ORG) : r === 'relationships.data' ? { orgs: joined() ? { [ORG]: { orgName: 'Missio Nexus', relationship: 'member', kind: 'org' } } : {} } : null), // the record's real shape: a map keyed by address
  nameOf: async (a: string) => (a === ORG ? 'missio-nexus.org' : null),
});
const ctx = (supplied: unknown[] = []) => ({ intent: { goal: 'accept the invitation' }, step: { toolId: 'organization.membership.accept', args: {}, id: 's0' }, index: 0, supplied } as never);

describe('organization.membership.accept', () => {
  it('refuses an organization that did not invite her, and says who must', async () => {
    const r = await membershipAcceptInvoker(deps(() => false), ME)('organization.membership.accept', { invitedTo: OTHER }, ctx()) as { refused?: string };
    expect(r.refused).toMatch(/no invitation from .* steward has to invite you first/);
  });
  it('an invitation that reached her parks for the Join ceremony at her Home', async () => {
    try { await membershipAcceptInvoker(deps(() => false), ME)('organization.membership.accept', { invitedTo: ORG }, ctx()); expect.unreachable(); }
    catch (e) {
      expect(isInputRequired(e)).toBe(true);
      const req = (e as { request: { kind: string; summary: { ceremony: string; org: string; orgName: string } } }).request;
      expect(req.kind).toBe('confirmation');
      expect(req.summary).toMatchObject({ ceremony: 'org-join', org: ORG, orgName: 'missio-nexus.org' });
    }
  });
  it('resumed: joined is what her records say — joined, or refused when nothing was recorded', async () => {
    let joined = true;
    const ok = await membershipAcceptInvoker(deps(() => joined), ME)('organization.membership.accept', { invitedTo: ORG }, ctx([{ stepRef: 's0', confirmed: true }])) as { joined?: boolean };
    // already a member ⇒ an answer, not a second membership
    expect(ok).toMatchObject({ joined: true, already: true });
    joined = false;
    let calls = 0;
    const flipping = { ...deps(() => calls++ > 0 && false) };
    const notRecorded = await membershipAcceptInvoker(flipping, ME)('organization.membership.accept', { invitedTo: ORG }, ctx([{ stepRef: 's0', confirmed: true }])) as { refused?: string };
    expect(notRecorded.refused).toMatch(/was not recorded — nothing changed/);
    let n = 0;
    const becomes = deps(() => n++ > 0);   // not joined when first read; joined after the ceremony
    const yes = await membershipAcceptInvoker(becomes, ME)('organization.membership.accept', { invitedTo: ORG }, ctx([{ stepRef: 's0', confirmed: true }])) as { joined?: boolean; already?: boolean };
    expect(yes).toMatchObject({ joined: true });
    expect(yes.already).toBeUndefined();
  });
});
