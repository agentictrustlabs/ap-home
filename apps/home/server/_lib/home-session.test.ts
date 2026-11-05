// Spec 445 §8 — under the Home's own audience only a real session passes, at every endpoint, from one place.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const SUB = 'eip155:1:0xeef5ed02e052ee221afcbbd2708919473c4e2b28';
vi.mock('@agenticprimitives/connect', () => ({
  verifyAgentSession: async (t: string) => (t === 'session' ? { ok: true, session: { sub: SUB, principal: { kind: 'passkey' } } } : t === 'id-token' ? { ok: true, session: { sub: SUB } } : { ok: false, reason: 'bad signature' }),
}));

import { verifySession } from './home-session';

const opts = (expectedAud: string) => ({ keys: [], expectedAud, expectedIss: 'https://home.test' });

describe('verifySession', () => {
  it('passes a Home session under the Home audience', async () => {
    expect((await verifySession('session', opts('demo-sso'))).ok).toBe(true);
  });
  it('refuses a token that names no credential under the Home audience: an id_token is not a session', async () => {
    expect(await verifySession('id-token', opts('demo-sso'))).toEqual({ ok: false, reason: 'not_a_home_session' });
  });
  it('leaves a verify under an app audience as it was: some endpoints take an app token on purpose', async () => {
    expect((await verifySession('id-token', opts('seed-bible-reader'))).ok).toBe(true);
  });
  it('passes a failure through unchanged', async () => {
    expect(await verifySession('junk', opts('demo-sso'))).toEqual({ ok: false, reason: 'bad signature' });
  });
});

describe('the server', () => {
  it('verifies a session in one place only', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p); } };
    walk(root);
    const direct = files.filter((f) => !f.endsWith('home-session.ts') && /verifyAgentSession\s*[(:,}]|verifyAgentSession\s+as\b/.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')));
    expect(direct.map((f) => f.slice(root.length + 1))).toEqual([]);
  });
});
