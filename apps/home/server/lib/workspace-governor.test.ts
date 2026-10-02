/**
 * A workspace holds no members — the pure parts of the server's guard (`server/lib/workspace-governor.ts`).
 *
 * WHAT THESE PIN: the two cheap truths a route may decide "this is a workspace" from (the caller's link, the
 * typed name), that a legacy `field-workspace` link counts, that nothing else does, and that the governor hint
 * never invents an address.
 */
import { describe, it, expect } from 'vitest';
import { governorHintOf, linkSaysWorkspace, nameSaysWorkspace, notAnOrganization, workspaceCheck } from './workspace-governor';

const PERSON = '0xeef5ed02e052ee221afcbbd2708919473c4e2b28';
const WS = '0xe26157068af46629691e2ab19726bf61476e6b6c';
const ORG = '0x1111111111111111111111111111111111111111';

describe('linkSaysWorkspace', () => {
  it('reads kind workspace, and the legacy purpose on a generic kind', () => {
    expect(linkSaysWorkspace({ kind: 'workspace' })).toBe(true);
    expect(linkSaysWorkspace({ kind: 'org', purpose: 'field-workspace' })).toBe(true);
    expect(linkSaysWorkspace({ purpose: 'field-workspace' })).toBe(true);
  });
  it('does not read an organization, a team, or nothing as a workspace', () => {
    expect(linkSaysWorkspace({ kind: 'org' })).toBe(false);
    expect(linkSaysWorkspace({ kind: 'team', purpose: 'field-workspace' })).toBe(false);
    expect(linkSaysWorkspace(null)).toBe(false);
  });
});

describe('nameSaysWorkspace', () => {
  it('reads the typed suffix in every form the grammar renders', () => {
    expect(nameSaysWorkspace('club.workspace')).toBe(true);
    expect(nameSaysWorkspace('club.workspace@field.org')).toBe(true);
    expect(nameSaysWorkspace('club.workspace.faithnet.agent')).toBe(true);
  });
  it('does not read an org, a person, a label that merely contains the word, or null', () => {
    expect(nameSaysWorkspace('club.org')).toBe(false);
    expect(nameSaysWorkspace('alice.me')).toBe(false);
    expect(nameSaysWorkspace('workspace.org')).toBe(false);
    expect(nameSaysWorkspace(null)).toBe(false);
  });
});

describe('governorHintOf', () => {
  it('prefers the written governor, then a parent that is not the person, and invents nothing', () => {
    expect(governorHintOf({ governor: ORG, parent: PERSON }, PERSON)).toBe(ORG);
    expect(governorHintOf({ parent: ORG }, PERSON)).toBe(ORG);
    expect(governorHintOf({ parent: PERSON }, PERSON)).toBeNull();
    expect(governorHintOf({ governor: 'club.org' }, PERSON)).toBeNull();
    expect(governorHintOf(null, PERSON)).toBeNull();
  });
});

describe('workspaceCheck', () => {
  const kv = (link: unknown) => ({ async get(k: string) { return k === `related:${PERSON}:${WS}` && link ? JSON.stringify(link) : null; } });

  it('decides from the link without a naming read', async () => {
    let asked = false;
    const r = await workspaceCheck(kv({ kind: 'workspace', governor: ORG }), PERSON, WS, async () => { asked = true; return null; });
    expect(r).toEqual({ workspace: true, governor: ORG });
    expect(asked).toBe(false);
  });

  it('falls back to the typed name when there is no link', async () => {
    expect(await workspaceCheck(kv(null), PERSON, WS, async () => 'club.workspace')).toEqual({ workspace: true, governor: null });
  });

  /* THE ORGANIZATION CASE IS UNCHANGED: a miss on both is an organization, which is every organization today. */
  it('answers not-a-workspace for an organization, and for a naming read that fails', async () => {
    expect(await workspaceCheck(kv({ kind: 'org' }), PERSON, ORG, async () => 'club.org')).toEqual({ workspace: false, governor: null });
    expect(await workspaceCheck(kv(null), PERSON, ORG, async () => { throw new Error('rpc'); })).toEqual({ workspace: false, governor: null });
  });

  it('shapes the refusal with the governor only when one is known', () => {
    expect(notAnOrganization(ORG)).toEqual({ error: 'not_an_organization', hint: 'a workspace is coordinated by a service agent; membership belongs to its governing organization', governor: ORG });
    expect(notAnOrganization(null)).not.toHaveProperty('governor');
  });
});
