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
