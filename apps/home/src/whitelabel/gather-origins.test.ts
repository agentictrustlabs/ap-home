/**
 * Round-4 D14 made Gather27 THREE websites — the host surface, the public map and the operator
 * console — but `gather-app`'s registry took exactly ONE deployment origin. Signing in from
 * `ops.gather27.faithnet.io` therefore reached Home and got "Request blocked", because the broker
 * refuses any `redirect_uri` whose origin is not registered for that client.
 *
 * These tests assert the real gate (`isAllowedRelyingOrigin`, which derives its set from this same
 * registry) rather than a re-description of it, and they pin the two properties that are easy to
 * lose: production's list must not widen by accident, and the HOST surface must stay the first
 * https entry.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { extraOrigins } from './config';

const HOST = 'https://gather27.faithnet.io/';
const OPS = 'https://ops.gather27.faithnet.io/';
const FIND = 'https://find.gather27.faithnet.io/';

/** Re-import the registry with a given environment, since it is read at module load. */
async function registryWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { whitelabel } = await import('./config');
  const { isAllowedRelyingOrigin } = await import('../lib/oidc-clients');
  const gather = whitelabel.relyingApps.find((a) => a.client_id === 'gather-app')!;
  /** Every client but Gather, as client_id → redirect_uris, for comparing across environments. */
  const others = Object.fromEntries(
    whitelabel.relyingApps.filter((a) => a.client_id !== 'gather-app').map((a) => [a.client_id, a.redirect_uris]),
  );
  return { gather, others, isAllowedRelyingOrigin };
}

const SAVED = {
  NEXT_PUBLIC_GATHER_ORIGINS: process.env['NEXT_PUBLIC_GATHER_ORIGINS'],
  NEXT_PUBLIC_GATHER_ORIGIN: process.env['NEXT_PUBLIC_GATHER_ORIGIN'],
};

beforeEach(() => {
  delete process.env['NEXT_PUBLIC_GATHER_ORIGINS'];
  delete process.env['NEXT_PUBLIC_GATHER_ORIGIN'];
});
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.resetModules();
});

describe('extraOrigins', () => {
  it('splits the plural list and trims', () => {
    expect(extraOrigins(`${HOST}, ${OPS} ,${FIND}`, undefined)).toEqual([HOST, OPS, FIND]);
  });

  it('falls back to the older single-value variable', () => {
    expect(extraOrigins(undefined, HOST)).toEqual([HOST]);
  });

  it('prefers the plural when both are set', () => {
    expect(extraOrigins(`${HOST},${OPS}`, FIND)).toEqual([HOST, OPS]);
  });

  it('never yields a blank origin from a trailing comma or an empty variable', () => {
    expect(extraOrigins(`${HOST},,  ,`, undefined)).toEqual([HOST]);
    expect(extraOrigins('', undefined)).toEqual([]);
    expect(extraOrigins(undefined, undefined)).toEqual([]);
  });
});

describe('the gather-app registry', () => {
  it('THE BUG: all three surfaces are allowed when the deployment names them', async () => {
    const { isAllowedRelyingOrigin } = await registryWith({
      NEXT_PUBLIC_GATHER_ORIGINS: `${HOST},${OPS},${FIND}`,
    });
    for (const uri of [HOST, OPS, FIND]) {
      expect(isAllowedRelyingOrigin(uri), `${uri} should be allowed`).toBe(true);
    }
  });

  it('keeps the HOST surface as the first https entry', async () => {
    // The org-invite return URL (server/connect/org-invite-lookup.ts) and the front-channel
    // sign-out hop both take the first https URI as the app's canonical address. If ops or the
    // workers.dev deployment drifts to the front, invite links leave for the wrong site.
    const { gather } = await registryWith({ NEXT_PUBLIC_GATHER_ORIGINS: `${HOST},${OPS},${FIND}` });
    const firstHttps = gather.redirect_uris.find((u) => u.startsWith('https:'));
    expect(firstHttps).toBe(HOST);
  });

  it('still honours a deployment that only sets the old single variable', async () => {
    const { isAllowedRelyingOrigin } = await registryWith({ NEXT_PUBLIC_GATHER_ORIGIN: HOST });
    expect(isAllowedRelyingOrigin(HOST)).toBe(true);
    expect(isAllowedRelyingOrigin(OPS)).toBe(false);
  });

  it('BLAST RADIUS: with neither variable set, production gains no origin', async () => {
    const { gather, isAllowedRelyingOrigin } = await registryWith({});
    expect(gather.redirect_uris).toEqual([
      'https://gather27-web.richardpedersen3.workers.dev/',
      'http://localhost:5175/',
      'http://127.0.0.1:5175/',
      'https://gather27-web-churchglobal.richardpedersen3.workers.dev/',
    ]);
    for (const uri of [HOST, OPS, FIND]) {
      expect(isAllowedRelyingOrigin(uri), `${uri} must NOT be allowed`).toBe(false);
    }
  });

  it('does not widen any OTHER client', async () => {
    // Not "poker.faithnet.io is refused" — that is Pokernight's own registered origin and SHOULD be
    // allowed. The property worth testing is that Gather's variable changes nobody else's list.
    const off = await registryWith({});
    const on = await registryWith({ NEXT_PUBLIC_GATHER_ORIGINS: `${HOST},${OPS},${FIND}` });
    expect(on.others).toEqual(off.others);
    expect(on.isAllowedRelyingOrigin('https://evil.example/')).toBe(false);
  });
});
