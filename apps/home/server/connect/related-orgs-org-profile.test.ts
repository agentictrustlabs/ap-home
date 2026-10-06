/**
 * `/connect/related-orgs` — the organization's common name, from the steward's save to a relying app's row.
 *
 * WHAT THESE PIN:
 *   • a relying app receives `displayName` (and `website`) BESIDE `orgName`, read from the link row;
 *   • a `displayName` that only repeats the naming-service name — what creation seeds — is not returned;
 *   • the projection is a steward's write onto a link that already exists: a member is refused, and a
 *     person with no link to the organization does not acquire one by projecting a profile onto it.
 *
 * The session verifier is stubbed (the token's `sub` is whatever the test says); everything after it —
 * the KV rows and the handlers — is the real code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const PERSON = '0xeef5ed02e052ee221afcbbd2708919473c4e2b28';
const ORG = '0xe26157068af46629691e2ab19726bf61476e6b6c';
const CLIENT = 'gc-engage';

vi.mock('../_lib/server-broker', () => ({
  getServer: async () => ({ jwks: { keys: [] } }),
  resolveOrigin: () => 'https://home.test',
  ownIssuer: () => 'https://home.test',
}));
vi.mock('@agenticprimitives/connect', () => ({
  importJwks: async () => [],
  verifyAgentSession: async () => ({ ok: true, session: { sub: `eip155:1:${PERSON}` } }),
}));

import { onRequestGet, onRequestPost } from './related-orgs';

let store: Map<string, string>;
const ctx = (request: Request) =>
  ({
    request,
    env: {
      AUTH_CODES: {
        async get(k: string) { return store.get(k) ?? null; },
        async put(k: string, v: string) { store.set(k, v); },
        async delete(k: string) { store.delete(k); },
      },
    },
  }) as never;

const project = (orgProfile: unknown) =>
  onRequestPost(ctx(new Request('https://home.test/connect/related-orgs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    body: JSON.stringify({ person: PERSON, orgAgent: ORG, orgProfile }),
  })));

const rowsFor = async () => {
  const r = await onRequestGet(ctx(new Request(`https://home.test/connect/related-orgs?client_id=${CLIENT}`, { headers: { authorization: 'Bearer t' } })));
  return ((await r.json()) as { orgs: Array<Record<string, unknown>> }).orgs;
};

const seedLink = (extra: Record<string, unknown> = {}) => {
  store.set(`related-idx:${PERSON}`, JSON.stringify([ORG]));
  store.set(`related:${PERSON}:${ORG}`, JSON.stringify({ orgAgent: ORG, orgName: 'global-church.org', purpose: 'related-org', requestedBy: CLIENT, siteDelegation: null, proofHash: null, relationship: 'steward', ...extra }));
};

describe('related-orgs — the organization common name', () => {
  beforeEach(() => { store = new Map(); });

  it('returns no displayName for a link that carries no projection', async () => {
    seedLink();
    const [row] = await rowsFor();
    expect(row!.orgName).toBe('global-church.org');
    expect(row).not.toHaveProperty('displayName');
    expect(row).not.toHaveProperty('website');
  });

  it('returns the steward\'s saved name and website beside orgName', async () => {
    seedLink();
    expect((await project({ displayName: 'Global.Church', website: 'https://global.church' })).status).toBe(200);
    const [row] = await rowsFor();
    expect(row).toMatchObject({ orgName: 'global-church.org', displayName: 'Global.Church', website: 'https://global.church' });
  });

  it('does not return a display name that only repeats the naming-service name', async () => {
    seedLink();
    await project({ displayName: 'global-church.org' });
    expect((await rowsFor())[0]).not.toHaveProperty('displayName');
  });

  it('stops returning the name once the steward clears it, and leaves the rest of the link alone', async () => {
    seedLink({ stewardshipDelegation: { delegator: ORG, delegate: PERSON } });
    await project({ displayName: 'Global.Church' });
    await project({ displayName: '', website: '' });
    const stored = JSON.parse(store.get(`related:${PERSON}:${ORG}`)!);
    expect(stored).not.toHaveProperty('orgProfile');
    expect(stored.stewardshipDelegation).toEqual({ delegator: ORG, delegate: PERSON });
    expect((await rowsFor())[0]).not.toHaveProperty('displayName');
  });

  it('refuses a member — only a steward can have written the record this mirrors', async () => {
    seedLink({ relationship: 'member' });
    expect((await project({ displayName: 'Not Theirs To Name' })).status).toBe(403);
    expect((await rowsFor())[0]).not.toHaveProperty('displayName');
  });

  it('never creates a link', async () => {
    expect((await project({ displayName: 'Global.Church' })).status).toBe(403);
    expect(store.size).toBe(0);
  });
});
