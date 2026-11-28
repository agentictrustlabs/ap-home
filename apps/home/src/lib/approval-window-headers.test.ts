import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config.mjs';
import { APPROVAL_WINDOW_ROUTES } from './approval-window-headers.mjs';

// What a browser is SENT for a path: Next applies every matching `headers()` entry in order, the last one of a key winning.
async function coopFor(path: string, query: Record<string, string>): Promise<string | undefined> {
  const rules = (await (nextConfig as { headers: () => Promise<Array<{ source: string; has?: Array<{ type: string; key: string }>; headers: Array<{ key: string; value: string }> }>> }).headers());
  let coop: string | undefined;
  for (const r of rules) {
    const matches = r.source === '/(.*)' || r.source === path;
    const has = (r.has ?? []).every((h) => h.type === 'query' && h.key in query);
    if (!matches || !has) continue;
    for (const h of r.headers) if (h.key === 'Cross-Origin-Opener-Policy') coop = h.value;
  }
  return coop;
}

describe('an approval window an app opens keeps its opener (so it can close itself)', () => {
  it('each approval page, opened with the app\'s return address, answers COOP unsafe-none', async () => {
    for (const path of APPROVAL_WINDOW_ROUTES) expect(await coopFor(path, { from: 'family-field', return: 'https://ap-family.faithnet.io/' }), path).toBe('unsafe-none');
  });
  it('the same page without a return address, and every other page, keep the strict baseline', async () => {
    expect(await coopFor('/household-steward-invitation', {})).toBe('same-origin-allow-popups');
    expect(await coopFor('/friends', { return: 'https://ap-family.faithnet.io/' })).toBe('same-origin-allow-popups');
  });
});
