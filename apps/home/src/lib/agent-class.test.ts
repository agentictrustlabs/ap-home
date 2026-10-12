// What a person can charter, and what the substrate then calls it (ADR-0046 / spec 346).
import { describe, expect, it } from 'vitest';
import { agentClassOf, serviceRoleOf, orgKindWordOf, kindWordOf, creatableKinds } from './agent-class';
import { typedTldForKind } from '../connect-client';

const all = () => true;
// The suffix a kind names regardless of provisioning (mirrors typedTldForKind's own table).
const kindSuffix = (k: string) => ({ person: 'me', org: 'org', circle: 'circle', church: 'church', household: 'household', team: 'team', workspace: 'workspace', 'person-treasury': 'treasury', 'org-treasury': 'treasury', service: 'svc' } as Record<string, string>)[k];

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

  /**
   * ANOTHER PERSON OF YOURS is chartered like anything else and is the one kind that is person-CLASS: a
   * trail name, a pen name, a part in a game. It claims `.me` like your first one, and it carries no service
   * role — declaring one on a person SA would fail the typed claim closed (spec 346 §3.6).
   */
  it('offers another person of yours, person-class, claiming .me and carrying no service role', () => {
    const person = creatableKinds('person', all);
    expect(person.map((c) => c.kind)).toContain('person');
    expect(typedTldForKind('person')).toEqual({ tld: 'me' });
    expect(agentClassOf('person')).toBe('person');
    expect(serviceRoleOf('person')).toBe('');
    expect(kindWordOf('person')).toBe('person');
    // and it is not offered under an ORGANIZATION: an org does not have people of its own.
    expect(creatableKinds('org', all).map((c) => c.kind)).not.toContain('person');
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

/**
 * THE NAME RECORD'S CLASS IS THE AGENT'S CLASS (spec 346 §3.6).
 *
 * Both claim paths used to enumerate the org kinds by hand and send everything else as 'service'. That was
 * invisible while every chartered kind really was org or service — and the moment a person joined the list it
 * meant chartering one would declare `atl:agentType person` on chain and then claim a `.me` name saying
 * service-class, which the typed claim refuses outright. A classifier, not a list, is what stops that
 * happening again for the next kind.
 */
describe('the class a claim records', () => {
  it('is person for a person, org for every org-shaped kind, service for the rest', () => {
    expect(agentClassOf('person')).toBe('person');
    for (const k of ['org', 'team', 'circle', 'church', 'household'] as const) expect(agentClassOf(k)).toBe('org');
    for (const k of ['service', 'workspace', 'person-treasury', 'org-treasury'] as const) expect(agentClassOf(k)).toBe('service');
  });
});

describe('the kinds born with their planes', () => {
  it('covers every record-keeping child kind the Ask-chartered genesis provisions, and no treasury or person', async () => {
    const { KINDS_BORN_WITH_PLANES } = await import('./agent-class');
    for (const k of ['org', 'team', 'workspace', 'service']) expect(KINDS_BORN_WITH_PLANES.has(k)).toBe(true);
    for (const k of ['person', 'person-treasury', 'org-treasury']) expect(KINDS_BORN_WITH_PLANES.has(k)).toBe(false);
  });
});
