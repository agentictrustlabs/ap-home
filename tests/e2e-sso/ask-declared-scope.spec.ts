/**
 * THE HOME DECLARES WHAT IT CAN FINISH — spec 353 S1/S2/S4, asserted on the wire.
 *
 * Everything else about scope can pass while the surface declares nothing: the agent's filters work, the
 * generators are tested, and the request that actually leaves the browser carries no scope at all. Silence
 * is correctly not a narrowing, so nothing breaks — the mechanism is simply never exercised, and a
 * regression in it would be invisible.
 *
 * So this test reads the real request body the real flyout sends, and asserts the scope is there, is
 * GENERATED (it matches the agent's published vocabulary ∩ what this surface renders), and is honest about
 * the one ceremony the Home cannot collect: a second party's approval.
 */
import { test, expect } from '@playwright/test';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';

test('the Home declares a scope generated from the agent’s published vocabulary', async ({ page, request }) => {
  const vocabRes = await request.get(`${HOME}/a2a/harness/vocabulary`);
  expect(vocabRes.ok(), 'the agent publishes its vocabulary').toBeTruthy();
  const { capabilities } = (await vocabRes.json()) as { capabilities: Array<{ id: string; ceremonies: string[] }> };
  expect(capabilities.length, 'the vocabulary is not empty').toBeGreaterThan(0);

  const signin = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'alice', client_id: 'demo-jp' } });
  const { homeSession } = (await signin.json()) as { homeSession: string };
  await page.goto(`${HOME}/#session=${homeSession}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('ask-toggle')).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(2_000);

  // Catch the ask on its way out.
  const sent = page.waitForRequest((r) => r.url().includes('/harness/ask') && r.method() === 'POST', { timeout: 60_000 });
  await page.getByTestId('ask-toggle').click();
  await page.getByTestId('ask-input').fill('what can you do here?');
  await page.getByTestId('ask-input').press('Enter');
  const body = JSON.parse((await sent).postData() ?? '{}') as { surface?: { capabilities?: string[]; ceremonies?: string[] } };

  const surface = body.surface;
  expect(surface, 'the request carries a scope').toBeTruthy();

  // The ceremonies are what this surface can RENDER. `approval` is absent on purpose: the flyout has
  // nowhere to collect a second party, and claiming otherwise would strand a plan that reached one.
  expect(surface!.ceremonies).toEqual(expect.arrayContaining(['data', 'confirmation', 'signature']));
  expect(surface!.ceremonies, 'the Home does not claim a ceremony it cannot render').not.toContain('approval');

  // GENERATED, not curated: exactly the published capabilities this surface can finish.
  const renders = new Set(surface!.ceremonies ?? []);
  const expected = capabilities.filter((c) => c.ceremonies.every((x) => renders.has(x))).map((c) => c.id).sort();
  expect((surface!.capabilities ?? []).slice().sort(), 'the declared list is the published ∩ the renderable').toEqual(expected);
});
