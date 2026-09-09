import { describe, it, expect } from 'vitest';
import { subjectAddress, servesUnpublishedNames } from '../src/subject-address.js';

const P = ['me', 'impact'];
const A = { ownIngress: 'https://edge.faithnet.io', ownDomains: ['faithnet.ai', 'faithnet.io'], parents: P, servesUnpublished: true };
const B = { ownIngress: 'https://edge-b.faithnet.io', ownDomains: ['b.faithnet.io'], parents: P, servesUnpublished: false };

describe('subject-address — where a subject is asked is what its name publishes (spec 366 R4)', () => {
  it('records naming this deployment’s own ingress ⇒ here', () => {
    const r = subjectAddress('alice.me', { a2aEndpoint: 'https://edge.faithnet.io/api/a2a/alice.me', cardUri: 'https://alice.faithnet.ai/.well-known/agent-card.json' }, A);
    expect(r.where).toBe('here');
  });
  it('records naming a host on a zone this deployment serves ⇒ here (even with no ingress configured)', () => {
    const r = subjectAddress('alice.me', { cardUri: 'https://alice.faithnet.ai/.well-known/agent-card.json' }, { ...A, ownIngress: undefined });
    expect(r.where).toBe('here');
  });
  it('records naming another deployment ⇒ wire, to the card the records name, pinned when the name pins', () => {
    const r = subjectAddress('dave-s-table.org', { a2aEndpoint: 'https://edge-b.faithnet.io/api/a2a/dave-s-table.org', cardUri: 'https://dave-s-table-org.b.faithnet.io/.well-known/agent-card.json', cardDigest: '0x' + 'ab'.repeat(32) }, A);
    expect(r).toEqual({ where: 'wire', cardUrl: 'https://dave-s-table-org.b.faithnet.io/.well-known/agent-card.json', pinnedDigest: '0x' + 'ab'.repeat(32) });
  });
  it('an endpoint with no cardUri ⇒ the card at the endpoint’s origin; a malformed pin is not a pin', () => {
    const r = subjectAddress('x.org', { a2aEndpoint: 'https://edge-b.faithnet.io/api/a2a/x.org', cardDigest: 'not-a-digest' }, A);
    expect(r).toEqual({ where: 'wire', cardUrl: 'https://edge-b.faithnet.io/.well-known/agent-card.json' });
  });
  it('the same records seen from the other deployment ⇒ here there', () => {
    const r = subjectAddress('dave-s-table.org', { a2aEndpoint: 'https://edge-b.faithnet.io/api/a2a/dave-s-table.org' }, B);
    expect(r.where).toBe('here');
  });
  it('no endpoint published: the default deployment serves it; a second deployment routes it nowhere, saying why', () => {
    expect(subjectAddress('bob.me', {}, A).where).toBe('here');
    const r = subjectAddress('bob.me', {}, B);
    expect(r.where).toBe('nowhere');
    expect((r as { refused: string }).refused).toMatch(/publishes no A2A endpoint or card/);
  });
  it('a name the registry does not know, or no name at all ⇒ nowhere', () => {
    expect(subjectAddress('ghost.me', null, A).where).toBe('nowhere');
    expect(subjectAddress(null, null, A).where).toBe('nowhere');
  });
  it('a host that merely LOOKS like ours is not ours: equality with the one host we serve the name at, never a suffix', () => {
    expect(subjectAddress('alice.me', { a2aEndpoint: 'https://edge.faithnet.io.evil.example/api/a2a/alice.me' }, A).where).toBe('wire');
    // B lives on a subdomain of A's zone; A serves dave-s-table.org at dave-s-table-org.faithnet.io, not there.
    expect(subjectAddress('dave-s-table.org', { cardUri: 'https://dave-s-table-org.b.faithnet.io/.well-known/agent-card.json' }, A).where).toBe('wire');
    expect(subjectAddress('dave-s-table.org', { cardUri: 'https://dave-s-table-org.faithnet.io/.well-known/agent-card.json' }, A).where).toBe('here');
  });
  it('A2A_SERVES_UNPUBLISHED_NAMES: only an explicit "false" says no', () => {
    expect(servesUnpublishedNames({})).toBe(true);
    expect(servesUnpublishedNames({ A2A_SERVES_UNPUBLISHED_NAMES: '' })).toBe(true);
    expect(servesUnpublishedNames({ A2A_SERVES_UNPUBLISHED_NAMES: 'false' })).toBe(false);
    expect(servesUnpublishedNames({ A2A_SERVES_UNPUBLISHED_NAMES: 'FALSE' })).toBe(false);
  });
});
