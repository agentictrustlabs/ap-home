/**
 * SPEC 414 A1 IN THE HOME — a person opens what her agent did and takes its provenance with her.
 *
 * Alice asks her agent a question (the API, as the Ask does), then opens Activities → "What this agent did", inspects
 * that run, and downloads its PROV graph from the inspector. What she takes away is the W3C record: the run names the
 * DOOR it arrived by, the VARIANT it ran under and the HARNESS CAPABILITIES that engaged — and carries none of her words.
 */
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
const MARK = `e2e-414-${Date.now().toString(36)}`;
const ASK = `which organizations am I part of — ${MARK}`;

test('the run inspector shows a fresh run and its PROV graph names the door, the variant and the engagements', async ({ page, request }) => {
  const si = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'alice', client_id: 'demo-web' } });
  expect(si.ok(), 'demo-signin').toBeTruthy();
  const { homeSession, agent } = (await si.json()) as { homeSession: string; agent: string };

  // The run — through the same /a2a door the Ask uses.
  const csrf = await request.get(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
  const token = ((await csrf.json()) as { token?: string }).token ?? '';
  const cookie = (csrf.headers()['set-cookie'] ?? '').split(';')[0];
  const asked = await request.post(`${HOME}/a2a/harness/ask`, { headers: { origin: HOME, cookie, 'x-csrf-token': token, 'content-type': 'application/json' }, data: { session: homeSession, addressee: String(agent).toLowerCase(), message: ASK }, timeout: 120_000 });
  const env = (await asked.json()) as { reply?: { kind: string }; runRef?: string; hasProvenance?: { recordType: string } };
  expect(env.runRef, 'the ask names its run').toBeTruthy();
  expect(env.hasProvenance?.recordType).toBe(`run.provenance:${env.runRef}`);
  console.log(`  asked → ${env.reply?.kind} · run ${env.runRef}`);

  // The Home: Activities → the run → Inspect.
  await page.goto(`${HOME}/#session=${homeSession}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_500);
  await page.goto(`${HOME}/activities`, { waitUntil: 'domcontentloaded' });
  const history = page.getByTestId('run-history');
  await expect(history).toBeVisible({ timeout: 60_000 });
  const row = history.locator('.ui-row', { hasText: MARK }).first();
  await expect(row, 'the fresh run is listed').toBeVisible({ timeout: 60_000 });
  await row.getByRole('button', { name: 'Inspect' }).click();
  const inspector = page.getByTestId('run-inspector');
  await expect(inspector).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('run-timeline')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `artifacts/run-provenance-view-${MARK}.png`, fullPage: true });

  // Take the provenance away: the JSON-LD download.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByTestId('run-timeline').getByRole('button', { name: 'PROV (JSON-LD)' }).click(),
  ]);
  const doc = JSON.parse(await readFile((await download.path())!, 'utf8')) as { id?: string; graph?: Array<Record<string, unknown>>; provenance?: { id: string; graph: Array<Record<string, unknown>> } };
  const bundle = doc.graph ? doc : doc.provenance!;
  expect(bundle.id).toBe(`urn:ap:prov:bundle:${env.runRef}`);
  const run = bundle.graph!.find((n) => n['id'] === `urn:ap:prov:act:${env.runRef}`)!;
  expect(run, 'the run activity').toBeTruthy();
  const door = bundle.graph!.find((n) => n['id'] === run['arrivedBy']);
  expect(door?.['doorKind'], 'the door the run arrived by').toBe('harness-ask');
  expect(String(run['underVariant'])).toMatch(/^urn:ap:prov:variant:sha256:[0-9a-f]{64}$/);
  const engaged = (run['hasEngagement'] as Array<{ ofCapability: string }> | undefined) ?? [];
  expect(engaged.some((e) => /#hc-planner/.test(e.ofCapability)), 'a planner engaged').toBe(true);
  expect(JSON.stringify(bundle)).not.toContain(MARK);
  console.log(`  ✓ inspector opened; PROV download names door ${String(door?.['doorKind'])}, a sha256 variant, ${engaged.length} engagement(s); none of the ask's words`);
});
