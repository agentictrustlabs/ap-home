import { describe, it, expect } from 'vitest';
import { ardHostManifest, ARD_A2A_CARD_TYPE } from '../src/ard.js';

describe('per-host ARD manifest (spec 347 §8.5)', () => {
  it('publishes exactly one entry whose url is this host\'s own well-known card and whose identity aligns with the URN publisher', () => {
    const m = ardHostManifest({ host: 'alice.faithnet.io', agent: '0x' + 'a'.repeat(40), name: 'alice.me', displayName: 'Alice', description: 'd', agentType: 'person', skills: [{ id: 'adv:estate-planning', examples: ['plan my estate', 'draft a will', 'x'] }, { id: 'adv:tax' }], cardDigest: 'sha256:' + 'ab'.repeat(32), cardSource: 'released' });
    expect(m.entries).toHaveLength(1);
    const e = m.entries[0]!;
    expect(e).toMatchObject({ identifier: 'urn:air:alice.faithnet.io:agent:alice', type: ARD_A2A_CARD_TYPE, url: 'https://alice.faithnet.io/.well-known/agent-card.json', capabilities: ['adv:estate-planning', 'adv:tax'], representativeQueries: ['plan my estate', 'draft a will', 'x'], 'ap:cardSource': 'released' });
    expect((e.trustManifest as { identity: string }).identity).toBe('https://alice.faithnet.io');
    expect(JSON.stringify(m)).not.toMatch(/mcp/i);
  });
  it('a single example never becomes representativeQueries (ARD wants 2–5) and a nameless agent falls back to its address', () => {
    const e = ardHostManifest({ host: 'h.example', agent: '0xABC', skills: [{ id: 's', examples: ['one'] }] }).entries[0]!;
    expect(e.representativeQueries).toBeUndefined();
    expect(e.identifier).toBe('urn:air:h.example:agent:0xabc');
  });
});
