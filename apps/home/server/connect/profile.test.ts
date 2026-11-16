import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { personFromBearer } from '../_lib/person-bearer';
import { onRequestGet, onRequestOptions } from './profile';
vi.mock('../_lib/person-bearer', () => ({ personFromBearer: vi.fn() }));
const person = '0x1111111111111111111111111111111111111111';
const photo = 'data:image/png;base64,iVBORw0KGgo=';
const ctx = () => ({ request: new Request('https://www.faithnet.me/connect/profile?person=someone-else', {
  headers: { origin: 'https://ap-family.faithnet.io', authorization: 'Bearer relying-token' },
}), env: { A2A_CUSTODY_URL: 'https://a2a.faithnet.io' } } as any);
beforeEach(() => vi.mocked(personFromBearer).mockResolvedValue({ person, token: 'relying-token', via: 'app', client: 'family-field' }));
afterEach(() => vi.unstubAllGlobals());
it('forwards the exact relying bearer and projects only the authenticated person’s display fields', async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true, record: { contact: { firstName: 'Pat', lastName: 'Parent', photo, email: 'private@example.test', phone: 'private', location: { street: 'private' } } } }));
  vi.stubGlobal('fetch', fetch);
  const response = await onRequestGet(ctx());
  expect(await response.json()).toEqual({ ok: true, person, firstName: 'Pat', lastName: 'Parent', photo });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(`https://a2a.faithnet.io/interactions/${person}/record.get`);
  expect(JSON.parse(String(init.body))).toEqual({ session: 'relying-token', recordType: 'impact-profile' });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('access-control-allow-origin')).toBe('https://ap-family.faithnet.io');
});
it.each([['read_grant_absent', 409], ['read_grant_revoked', 403], ['read_grant_scope', 403]] as const)('preserves %s, without using another authority', async (code, status) => {
  const fetch = vi.fn(async () => Response.json({ error: 'refused', code }, { status }));
  vi.stubGlobal('fetch', fetch);
  const response = await onRequestGet(ctx());
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: 'refused', code });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('refuses an unauthenticated read before touching the vault', async () => {
  vi.mocked(personFromBearer).mockResolvedValue(null);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect((await onRequestGet(ctx())).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});
it('supports the browser’s authorization preflight', async () => {
  expect((await onRequestOptions(ctx())).headers.get('access-control-allow-headers')).toContain('authorization');
});
it('reports a missing photo without substituting an image from elsewhere', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, record: null })));
  expect(await (await onRequestGet(ctx())).json()).toMatchObject({ photo: null });
});
it.each(['https://tracking.example.test/me.jpg', 'data:image/svg+xml;base64,PHN2Zz4='])('refuses an unsafe photo %s', async photo => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, record: { contact: { photo } } })));
  expect((await onRequestGet(ctx())).status).toBe(422);
});
