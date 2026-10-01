// Spec 422 §3.3 — unlinking a channel is a TOMBSTONE over an append-only facet (SEC-009), never a delete.
import { describe, it, expect } from 'vitest';
import type { CanonicalAgentId } from '@agenticprimitives/types';
import { liveLinks, readEmailFacet, recordEmailFacet, unlinkEmailFacet, readPhoneFacet, recordPhoneFacet, unlinkPhoneFacet, type KvLike } from './kv-indexer';

const A = 'eip155:84532:0x1111111111111111111111111111111111111111' as CanonicalAgentId;
const B = 'eip155:84532:0x2222222222222222222222222222222222222222' as CanonicalAgentId;

function memKv(): KvLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return { store, get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } };
}

describe('liveLinks', () => {
  it('a tombstone removes every earlier link of that agent and nothing else; a later re-link counts again', () => {
    const live = liveLinks([
      { agent: A, assurance: 'asserted', ref: 'kv-email' },
      { agent: B, assurance: 'asserted', ref: 'kv-email' },
      { agent: A, assurance: 'unverified', ref: 'tombstone:kv-email' },
      { agent: A, assurance: 'asserted', ref: 'kv-email' },
    ]);
    expect(live.map((l) => l.agent)).toEqual([B, A]);
  });
});

describe('unlinkEmailFacet / unlinkPhoneFacet', () => {
  it('after unlinking, the email no longer resolves to the agent, the history is still in KV, and re-linking works', async () => {
    const kv = memKv();
    await recordEmailFacet(kv, 'rich@example.org', A);
    expect(await readEmailFacet(kv, 'rich@example.org')).toBe(A);
    expect(await unlinkEmailFacet(kv, 'rich@example.org', A)).toBe(true);
    expect(await readEmailFacet(kv, 'rich@example.org')).toBeNull();
    const raw = JSON.parse([...kv.store.values()][0]!) as Array<{ ref: string }>;
    expect(raw).toHaveLength(2);
    expect(raw[1]!.ref).toBe('tombstone:kv-email');
    // idempotent: nothing live to tombstone
    expect(await unlinkEmailFacet(kv, 'rich@example.org', A)).toBe(false);
    await recordEmailFacet(kv, 'rich@example.org', A);
    expect(await readEmailFacet(kv, 'rich@example.org')).toBe(A);
  });

  it('unlinking only touches the named agent — another agent linked to the same phone stays', async () => {
    const kv = memKv();
    await recordPhoneFacet(kv, '+13035551234', A);
    await recordPhoneFacet(kv, '+13035551234', B);
    expect(await unlinkPhoneFacet(kv, '+13035551234', A)).toBe(true);
    expect(await readPhoneFacet(kv, '+13035551234')).toBe(B);
  });
});
