// Spec 397 §11.5 — a Home session never rides a routed ask to another host, except a peer deployment this one names.
import { describe, it, expect } from 'vitest';
import { wireCredentialFor } from '../src/subject-hop-credential.js';

const CARD = 'https://scripture.faithnet.io/.well-known/agent-card.json';
describe('wireCredentialFor', () => {
  it('never sends the Home session to a self-hosted service', () => {
    const r = wireCredentialFor({ cardUrl: CARD, session: 'tok', name: 'scripture-resolver.svc' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('tok');
  });
  it('sends the app delegation the run was admitted under, and no session', () => {
    const r = wireCredentialFor({ cardUrl: CARD, session: 'tok', appCredential: { authorization: 'A2A-Session x', body: '{}' }, name: 's' });
    expect(r).toMatchObject({ ok: true, credential: { kind: 'app-delegation' } });
    expect((r as { session?: string }).session).toBeUndefined();
  });
  it('sends the session to a peer deployment this one names', () => {
    const r = wireCredentialFor({ cardUrl: 'https://alice-me.a2a-b.faithnet.io/.well-known/agent-card.json', session: 'tok', trustedOrigins: 'https://a2a-b.faithnet.io', name: 'alice.me' });
    expect(r).toMatchObject({ ok: true, credential: { kind: 'home-session', token: 'tok' }, session: 'tok' });
  });
  it('a peer list never matches by suffix of an unrelated host', () => {
    const r = wireCredentialFor({ cardUrl: 'https://evil-a2a-b.faithnet.io.example/x', session: 'tok', trustedOrigins: 'https://a2a-b.faithnet.io', name: 'x' });
    expect(r.ok).toBe(false);
  });
});

import { pairwiseSubjectPort, PAIRWISE_SECRET_RECORD } from '../src/subject-hop-credential.js';
describe('pairwiseSubjectPort', () => {
  const ME = '0x15200e7140667090106861f42024fa3a6f60230e';
  function vault(initial?: unknown) {
    const store = new Map<string, unknown>(); if (initial) store.set(PAIRWISE_SECRET_RECORD, initial);
    const writes: string[] = [];
    return { store, writes, deps: { readSubjectRecord: async (_s: string, rt: string) => store.get(rt) ?? null, writeSubjectRecord: async (_s: string, rt: string, r: unknown) => { store.set(rt, r); writes.push(rt); return { ok: true }; } } };
  }
  it('mints her secret once, keeps it in her vault, and derives a stable pseudonym per audience', async () => {
    const v = vault();
    const port = pairwiseSubjectPort(v.deps, ME);
    const a1 = await port('https://scripture.example'); const a2 = await port('https://scripture.example'); const b = await port('https://other.example');
    expect(a1).toMatch(/^usr_[A-Za-z0-9_-]{22}$/); expect(a1).toBe(a2); expect(b).not.toBe(a1);
    expect(v.writes).toEqual([PAIRWISE_SECRET_RECORD]);
    expect(JSON.stringify(v.store.get(PAIRWISE_SECRET_RECORD))).not.toContain(ME.slice(2));
  });
  it('uses the secret her vault already holds and never rewrites it', async () => {
    const v = vault({ type: 'ap.pairwise-secret.v1', secret: `0x${'ab'.repeat(32)}`, rotation: 0, createdAt: 'x' });
    await pairwiseSubjectPort(v.deps, ME)('https://scripture.example');
    expect(v.writes).toEqual([]);
  });
  it('refuses without a person, and when her vault will not keep the secret', async () => {
    await expect(pairwiseSubjectPort(vault().deps, undefined)('https://x.example')).rejects.toThrow(/no person/);
    const refusing = { readSubjectRecord: async () => null, writeSubjectRecord: async () => ({ ok: false, error: 'record_scope_denied' }) };
    await expect(pairwiseSubjectPort(refusing, ME)('https://x.example')).rejects.toThrow(/re-enable storage/);
  });
});
