/**
 * SPEC 415 §5a–c IN THE HOME — the Lab and the run tree, as a person reads them.
 *
 * 1. Developer → Evals → "Skill selection (playbooks)": what was tested, the recommendations to act on (each with the
 *    change to make), every test sentence with the skill that should have been chosen and the one that was, the
 *    "only wrong" filter, the leaked-into-examples flag, each playbook skill, and the glossary.
 * 2. A fresh run's inspector → "how it ran": the tree from the door — the run, its steps with the authority column —
 *    and the run's measurements read back from the vault on request.
 */
import { test, expect } from '@playwright/test';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';

async function signIn(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext, handle = 'alice') {
  const si = await request.post(`${HOME}/connect/demo-signin`, { data: { handle, client_id: 'demo-web' } });
  expect(si.ok(), 'demo-signin').toBeTruthy();
  const out = (await si.json()) as { homeSession: string; agent: string };
  await page.goto(`${HOME}/#session=${out.homeSession}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_500);
  return out;
}

test('the Lab says what was tested, what was chosen for each sentence, and what to change', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto(`${HOME}/developer/evals/skills`, { waitUntil: 'domcontentloaded' });
  const lab = page.getByTestId('skill-assessment-lab');
  await expect(lab).toBeVisible({ timeout: 60_000 });
  await expect(lab.getByText('What this tests.')).toBeVisible();
  await expect(page.getByTestId('lab-headline').locator('li').first()).toBeVisible();

  const recs = page.getByTestId('lab-recommendation');
  expect(await recs.count(), 'recommendations to act on').toBeGreaterThan(0);
  await expect(recs.first()).toContainText('Change:');

  const intents = page.getByTestId('lab-intent');
  const all = await intents.count();
  expect(all, 'every test of the selected experiment').toBeGreaterThan(0);
  await expect(intents.first()).toContainText('should be');
  await expect(intents.first()).toContainText('chose');
  await page.getByTestId('lab-only-wrong').click();
  const wrong = await page.getByTestId('lab-intent').count();
  expect(wrong).toBeLessThanOrEqual(all);
  await page.getByTestId('lab-only-wrong').click();

  expect(await page.getByTestId('lab-skill').count(), 'each playbook skill').toBeGreaterThanOrEqual(12);
  await expect(page.getByText('should have declined').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/lab.png', fullPage: false });

  // The leaked-into-examples flag: stratum 2 carries sentences its skills' examples were written from.
  const stratum2 = page.getByRole('tab', { name: /stratum-2/ }).last();
  if (await stratum2.count()) {
    await stratum2.click();
    await expect(page.getByText('test leaked into examples').first()).toBeVisible({ timeout: 10_000 });
  }
});

test('a run opens as a tree from the door, with the authority column and its measurements', async ({ page, request }) => {
  // The measurements are written after the run's export, which waits on an on-chain anchor: allow for it.
  test.setTimeout(300_000);
  const { homeSession, agent } = await signIn(page, request);
  const csrf = await request.get(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
  const token = ((await csrf.json()) as { token?: string }).token ?? '';
  const cookie = (csrf.headers()['set-cookie'] ?? '').split(';')[0];
  const mark = `e2e-lab-${Date.now().toString(36)}`;
  const asked = await request.post(`${HOME}/a2a/harness/ask`, { headers: { origin: HOME, cookie, 'x-csrf-token': token, 'content-type': 'application/json' }, data: { session: homeSession, addressee: agent, message: `which organizations am I part of — ${mark}` } });
  const env = (await asked.json()) as { runRef?: string };
  expect(env.runRef, 'the ask names its run').toBeTruthy();

  await page.goto(`${HOME}/activities?run=${encodeURIComponent(env.runRef!)}`, { waitUntil: 'domcontentloaded' });
  const inspector = page.getByTestId('run-inspector');
  await expect(inspector).toBeVisible({ timeout: 60_000 });
  const tree = inspector.getByTestId('run-trace-tree');
  await expect(tree).toBeVisible();
  await expect(tree.getByTestId('trace-node-run')).toBeVisible();
  expect(await tree.getByTestId('trace-node-step').count(), 'the steps').toBeGreaterThan(0);
  await expect(tree.getByTestId('trace-authority').first()).toBeVisible();

  // Measurements land after the export (an anchor is an on-chain write) — ask again until they do.
  let got = false;
  for (let i = 0; i < 12 && !got; i++) {
    const load = tree.getByTestId('run-measures-load');
    if (await load.count()) await load.click();
    // `isVisible` does not wait (its timeout is ignored) — wait for the read to come back.
    got = await tree.getByTestId('run-measures').waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
    if (!got) { await page.waitForTimeout(10_000); await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.getByTestId('run-inspector')).toBeVisible({ timeout: 60_000 }); }
  }
  expect(got, 'the run\'s measurements read back from the vault').toBeTruthy();
  await inspector.screenshot({ path: 'test-results/run-tree.png' });
});
