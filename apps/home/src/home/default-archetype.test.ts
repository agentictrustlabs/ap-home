import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/domain', () => ({ SKILLS_REGISTRY_ORIGIN: 'https://registry.test' }));
vi.mock('../csrf', () => ({ ensureCsrfToken: async () => {}, csrfHeaders: () => ({}) }));

import { assignDefaultArchetype } from './default-archetype';

// The real pinned snapshots — also proves the committed definitions validate for this Home.
const snap = (p: string) => JSON.parse(readFileSync(new URL(`../../../../.agentic/definitions/${p}.json`, import.meta.url), 'utf8'));
const def = (archetypeId: string, _types: string[]) =>
  archetypeId.endsWith('wanderwell-household') ? snap('wanderwell/wanderwell-household') : snap('agentic-trust/household-steward');

let calls: Array<{ url: string; body?: any }>;
beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.startsWith('https://registry.test')) {
      if (url.includes('/contexts/wanderwell/archetypes/missing/')) return { ok: false, status: 404, json: async () => ({}) };
      const m = /archetypes\/([^/]+)\/definition/.exec(url)!;
      return { ok: true, status: 200, json: async () => ({ digest: '0x' + 'ab'.repeat(32), definition: def(`skill:archetypes/${m[1]}`, ['household']) }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('assignDefaultArchetype', () => {
  it('assigns the estate default for a household when no override is given', async () => {
    const r = await assignDefaultArchetype('0xAbC', 'household', 'tok');
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe('https://registry.test/context/contexts/agentic-trust/archetypes/household-steward/definition');
    expect(calls[1].body.record.archetypeId).toBe('skill:archetypes/household-steward');
  });

  it('assigns the client override instead of the default, to the lower-cased agent', async () => {
    const r = await assignDefaultArchetype('0xAbC', 'household', 'tok', { context: 'wanderwell', archetype: 'wanderwell-household' });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe('https://registry.test/context/contexts/wanderwell/archetypes/wanderwell-household/definition');
    expect(calls[1].body.communityId).toBe('0xabc');
    expect(calls[1].body.record.archetypeId).toBe(snap('wanderwell/wanderwell-household').archetypeId);
    expect(calls[1].body.record.definitionDigest).toBe('0x' + 'ab'.repeat(32));
  });

  it('an override that does not apply to the kind is refused, never written', async () => {
    const r = await assignDefaultArchetype('0xabc', 'person', 'tok', { context: 'wanderwell', archetype: 'wanderwell-household' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not apply to person/);
    expect(calls.some((c) => c.body)).toBe(false);
  });

  it('a registry failure on the override is reported, not thrown, and writes nothing', async () => {
    const r = await assignDefaultArchetype('0xabc', 'household', 'tok', { context: 'wanderwell', archetype: 'missing' });
    expect(r).toEqual({ ok: false, reason: 'registry 404' });
    expect(calls.some((c) => c.body)).toBe(false);
  });
});
