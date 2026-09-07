// What a person can charter, and what the substrate then calls it (ADR-0046 / spec 346).
import { describe, expect, it } from 'vitest';
import { agentClassOf, serviceRoleOf, orgKindWordOf, creatableKinds } from './agent-class';
import { typedTldForKind } from '../connect-client';

const all = () => true;
// The suffix a kind names regardless of provisioning (mirrors typedTldForKind's own table).
const kindSuffix = (k: string) => ({ org: 'org', circle: 'circle', church: 'church', household: 'household', team: 'team', workspace: 'workspace', 'person-treasury': 'treasury', 'org-treasury': 'treasury', service: 'svc' } as Record<string, string>)[k];

describe('chartering an agent', () => {
  it('offers every typed root, and each kind claims the suffix that names its type', () => {
    // The PRODUCT predicate: a kind is offered only when its typed root is provisioned on this deployment's
    // chain. `.household` (spec 368) is live on faithchain and not yet on Base Sepolia, so the offered list is
    // chain-dependent by design — what must hold everywhere is that nothing offered lacks its suffix.
    const claimable = (k: Parameters<typeof typedTldForKind>[0]) => !!typedTldForKind(k);
    const person = creatableKinds('person', claimable);
    expect(person.map((c) => c.kind)).toContain('service');
    expect(person.map((c) => c.kind)).toContain('org');
    for (const c of person) expect(typedTldForKind(c.kind)?.tld, c.kind).toBeTruthy();
    // And every kind the catalogue knows maps to SOME suffix — a root may be unprovisioned, never unnamed.
    for (const c of creatableKinds('person', all)) expect(['me', 'org', 'team', 'svc', 'workspace', 'treasury', 'church', 'circle', 'household']).toContain(kindSuffix(c.kind));
    expect(typedTldForKind('service')).toEqual({ tld: 'svc', serviceRole: 'service' });
    expect(typedTldForKind('team')?.tld).toBe('team');
  });

  it('never offers a kind whose typed root this chain has not provisioned', () => {
    const onlyOrg = creatableKinds('person', (k) => k === 'org');
    expect(onlyOrg.map((c) => c.kind)).toEqual(['org']);
    expect(creatableKinds('person', () => false)).toEqual([]);
  });

  it('an organization charters what belongs INSIDE it, not another organization', () => {
    const fromOrg = creatableKinds('org', all).map((c) => c.kind);
    expect(fromOrg).toEqual(['team', 'workspace', 'service', 'org-treasury']);
    expect(fromOrg).not.toContain('org');
  });

  it('classifies by the trichotomy: a team is an organization, a service agent is a service', () => {
    expect(agentClassOf('team')).toBe('org');
    expect(agentClassOf('church')).toBe('org');
    expect(agentClassOf('service')).toBe('service');
    expect(agentClassOf('workspace')).toBe('service');
    expect(orgKindWordOf('team')).toBe('team');
    expect(serviceRoleOf('service')).toBe('service');
  });

  it('counterparty-facing kinds require a name; plumbing may defer', () => {
    const byKind = Object.fromEntries(creatableKinds('person', all).map((c) => [c.kind, c.nameRequired]));
    expect(byKind.service).toBe(true);
    expect(byKind.org).toBe(true);
    expect(byKind['person-treasury']).toBe(false);
  });
});
