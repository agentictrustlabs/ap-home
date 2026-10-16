import { describe, expect, it } from 'vitest';

import { DEPLOYED_ORG_TTL_MS, forgetDeployedOrg, recallDeployedOrg, rememberDeployedOrg } from './org-deploy-stash';

const store = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    size: () => m.size,
  };
};
const PERSON = `0x${'a'.repeat(40)}`;
const ORG = `0x${'b'.repeat(40)}`;
const key = { app: 'gather-app', orgBase: 'Grace Church', person: PERSON };

describe('the organization a failed org-create left standing', () => {
  it('is recalled for the same app, name and person', () => {
    const s = store();
    rememberDeployedOrg(s, key, { orgAgent: ORG, orgName: 'grace-church.org' }, 1_000);
    expect(recallDeployedOrg(s, key, 2_000)).toEqual({ orgAgent: ORG, orgName: 'grace-church.org' });
  });

  it('matches the requested name without regard to case or spacing', () => {
    const s = store();
    rememberDeployedOrg(s, key, { orgAgent: ORG, orgName: 'grace-church.org' }, 1_000);
    expect(recallDeployedOrg(s, { ...key, orgBase: '  grace church ' }, 2_000)).not.toBeNull();
  });

  it('is not handed to another person on the same browser', () => {
    const s = store();
    rememberDeployedOrg(s, key, { orgAgent: ORG, orgName: 'grace-church.org' }, 1_000);
    expect(recallDeployedOrg(s, { ...key, person: `0x${'c'.repeat(40)}` }, 2_000)).toBeNull();
  });

  it('is not handed to a different app or a different name', () => {
    const s = store();
    rememberDeployedOrg(s, key, { orgAgent: ORG, orgName: 'grace-church.org' }, 1_000);
    expect(recallDeployedOrg(s, { ...key, app: 'other-app' }, 2_000)).toBeNull();
    expect(recallDeployedOrg(s, { ...key, orgBase: 'Hope Church' }, 2_000)).toBeNull();
  });

  it('lapses after the TTL, and the lapsed entry is dropped', () => {
    const s = store();
    rememberDeployedOrg(s, key, { orgAgent: ORG, orgName: 'grace-church.org' }, 1_000);
    expect(recallDeployedOrg(s, key, 1_000 + DEPLOYED_ORG_TTL_MS + 1)).toBeNull();
    expect(s.size()).toBe(0);
  });

  it('is forgotten once the grant is handed back', () => {
    const s = store();
    rememberDeployedOrg(s, key, { orgAgent: ORG, orgName: 'grace-church.org' }, 1_000);
    forgetDeployedOrg(s, key);
    expect(recallDeployedOrg(s, key, 2_000)).toBeNull();
  });

  it('ignores a damaged entry', () => {
    const s = store();
    s.setItem('ap_org_deployed:gather-app:grace church', '{not json');
    expect(recallDeployedOrg(s, key, 2_000)).toBeNull();
    s.setItem('ap_org_deployed:gather-app:grace church', JSON.stringify({ orgAgent: 'nope', person: PERSON, at: 1 }));
    expect(recallDeployedOrg(s, key, 2)).toBeNull();
  });
});
