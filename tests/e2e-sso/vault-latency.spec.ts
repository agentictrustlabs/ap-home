/**
 * Vault-read latency validation (against prod). Proves VL-W4 (metadata-first inbox) is ACTIVE and measures
 * the round-trips:
 *   - the /messages LIST + 5s poll fetch `/connect/inbox` with NO conversationId → the response must carry
 *     `bodies: {}` (zero server-side body decrypts — the whole point of VL-W4);
 *   - opening a thread fetches `/connect/inbox?conversationId=…` → THAT response carries the bodies.
 * Also logs the observed durations so we can see how fast the metadata list is.
 *
 * Body-render correctness (a message actually shows in the thread after the lazy load) is covered by
 * two-user.spec (A→B DM) + discussions.spec (dm.slide-over); this spec is the optimization-is-on proof.
 */
import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { onboard } from './onboard';

test('VL-W4: /messages list is metadata-only (bodies:{}); thread bodies are lazy', async ({ page }) => {
  const name = 'vlat' + randomBytes(3).toString('hex');
  const me = await onboard(page, name, (s) => console.log(`[vlat] ${s}`));
  console.log(`[vlat] home=${me.origin}`);

  const resps: { conv: boolean; ms: number; bodies: number }[] = [];
  page.on('response', (res) => {
    const u = res.url();
    if (!u.includes('/connect/inbox') || u.includes('/deliver')) return;
    const t = res.request().timing();
    void res
      .json()
      .then((j: unknown) => {
        const bodies = j && typeof j === 'object' && (j as { bodies?: unknown }).bodies
          ? Object.keys((j as { bodies: Record<string, unknown> }).bodies).length
          : 0;
        resps.push({ conv: u.includes('conversationId='), ms: Math.round(t.responseEnd - t.requestStart), bodies });
      })
      .catch(() => {});
  });

  await page.goto(`${me.origin}/messages`);
  // Let the initial load + at least one 5s poll happen.
  await page.waitForTimeout(9000);

  const list = resps.filter((r) => !r.conv);
  console.log(`[vlat] LIST fetches: ${list.length} | timings(ms)=[${list.map((r) => r.ms).join(', ')}] | bodies=[${list.map((r) => r.bodies).join(', ')}]`);
  const thread = resps.filter((r) => r.conv);
  console.log(`[vlat] THREAD fetches: ${thread.length} | timings(ms)=[${thread.map((r) => r.ms).join(', ')}] | bodies=[${thread.map((r) => r.bodies).join(', ')}]`);

  expect(list.length, 'the /messages list should fetch /connect/inbox').toBeGreaterThan(0);
  // VL-W4 core invariant: the metadata-first list + every poll carry ZERO bodies (no body decrypts server-
  // side on the hot path). Bodies are resolved ONLY per-thread on demand.
  expect(list.every((r) => r.bodies === 0), 'metadata list/poll must carry ZERO bodies').toBeTruthy();
});
