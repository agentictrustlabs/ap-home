/**
 * THE COOKIE THAT MADE EVERY ASK FAIL.
 *
 * `agentic-csrf` is shared across `faithnet.me` and `www.faithnet.me` — cookies ignore the host prefix —
 * and a host-scoped cookie can sit beside a domain-scoped one under the SAME name. Reading only the first
 * pinned whichever came out on top, so a token minted for the apex was sent from www and rejected as
 * `csrf invalid` on every request, permanently: re-minting wrote the other cookie and changed nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const ORIGIN = 'https://www.faithnet.me';
const APEX = 'https://faithnet.me';
const tokenFor = (origin: string): string => {
  const head = Buffer.from(JSON.stringify({ origin, ts: 1 })).toString('base64url');
  return `${head}.${Buffer.from('sig').toString('base64url')}`;
};

async function loadCsrf(cookie: string, origin = ORIGIN) {
  vi.resetModules();
  vi.stubGlobal('document', { cookie });
  vi.stubGlobal('window', { location: { origin } });
  vi.stubGlobal('atob', (b64: string) => Buffer.from(b64, 'base64').toString('binary'));
  return import('./csrf.js');
}

describe('csrfHeaders picks the token for THIS origin', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('finds the right token even when a wrong-origin cookie is listed FIRST', async () => {
    const mine = tokenFor(ORIGIN);
    const { csrfHeaders } = await loadCsrf(`agentic-csrf=${tokenFor(APEX)}; agentic-csrf=${mine}`);
    expect(csrfHeaders()['X-CSRF-Token']).toBe(mine);
  });

  it('REFUSES to send a token stamped for another origin — a certain rejection is not a last resort', async () => {
    const { csrfHeaders } = await loadCsrf(`agentic-csrf=${tokenFor(APEX)}`);
    // Throwing sends the caller to ensureCsrfToken() and a fresh mint; sending it anyway turned a
    // recoverable state into a permanent `csrf invalid`.
    expect(() => csrfHeaders()).toThrow(/this origin/);
  });

  it('reads a URL-encoded cookie value', async () => {
    const mine = tokenFor(ORIGIN);
    const { csrfHeaders } = await loadCsrf(`agentic-csrf=${encodeURIComponent(mine)}`);
    expect(csrfHeaders()['X-CSRF-Token']).toBe(mine);
  });

  it('ensureCsrfToken mints when no cookie is for this origin, and uses it', async () => {
    const minted = tokenFor(ORIGIN);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ token: minted }) })));
    const { ensureCsrfToken, csrfHeaders } = await loadCsrf(`agentic-csrf=${tokenFor(APEX)}`);
    expect(await ensureCsrfToken()).toBe(minted);
    expect(csrfHeaders()['X-CSRF-Token'], 'the freshly minted token is used even though the stale cookie remains').toBe(minted);
  });
});
