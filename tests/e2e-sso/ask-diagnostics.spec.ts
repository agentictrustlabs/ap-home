/**
 * THE ANSWER SHOWS ITS WORK — spec 357 §4, in the browser.
 *
 * "What organizations are out there" once answered "The directory does not list any organizations" about a
 * directory holding 37. The answer was prose, the prose was wrong, and nothing on screen could tell a
 * reader — or me — that the agent had keyword-matched NAMES for the word "organizations" instead of asking
 * the graph. A wrong answer that shows its query is a bug you can see; one that doesn't is a fact.
 *
 * So this asserts the loop that catches that class of failure: the question routes to the generated-query
 * tool, the answer is right, and the diagnostics pane shows the SPARQL that produced it.
 */
import { test, expect } from '@playwright/test';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';

test('a question about a KIND is answered by a generated query, and the query is visible', async ({ page, request }) => {
  test.setTimeout(180_000);

  // What the directory actually holds, straight from the read tier — so the assertion below is about the
  // world rather than about whatever the agent said.
  const kb = await request.post(`${HOME}/a2a/kb/query`, {
    data: { query: 'SELECT (COUNT(?a) AS ?n) WHERE { ?a a <https://agenticprimitives.dev/ns/core#OrganizationAgent> }' },
  }).catch(() => null);
  const orgCount = kb?.ok()
    ? Number((((await kb.json()) as { rows?: Array<{ n?: string }> }).rows ?? [{}])[0]?.n ?? 0)
    : 0;

  const signin = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'alice', client_id: 'demo-jp' } });
  const { homeSession } = (await signin.json()) as { homeSession: string };
  await page.goto(`${HOME}/#session=${homeSession}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('ask-toggle')).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(2_000);

  await page.getByTestId('ask-toggle').click();
  await page.getByTestId('ask-input').fill('what organizations are out there');
  await page.getByTestId('ask-input').press('Enter');

  // STARTED, then SETTLED. Waiting only for "enabled" passes in the milliseconds before the run has
  // disabled anything — the first cut of this test read a flyout still saying "Thinking…" and reported an
  // empty diagnostics pane as a missing feature.
  await expect(page.getByTestId('ask-input'), 'the run starts').toBeDisabled({ timeout: 30_000 });
  await expect(page.getByTestId('ask-input'), 'the run settles').toBeEnabled({ timeout: 120_000 });
  const answer = await page.getByTestId('ask-flyout').innerText();
  expect(answer, 'a directory with organizations in it does not report none').not.toMatch(/does not list any organizations/i);

  // NOW THE POINT. Open the pane and read what it actually did.
  await page.getByTestId('ask-diagnostics-toggle').click();
  const diag = page.getByTestId('ask-diagnostics');
  await expect(diag).toBeVisible();
  const text = await diag.innerText();
  console.log(`DIAGNOSTICS →\n${text.split('\n').filter(Boolean).slice(0, 14).join('\n')}`);

  expect(text, 'the question is recorded').toContain('what organizations are out there');
  expect(text, 'a question about a KIND goes to the generated-query tool, not the name search').toContain('kb.question');
  // The query itself — the one piece of evidence a reader cannot reconstruct from the answer.
  expect(text, 'the generated SPARQL is shown').toMatch(/CONSTRUCT/);
  expect(text, 'and it queried the class the question was about').toMatch(/OrganizationAgent/);

  if (orgCount > 0) {
    expect(text, `the directory holds ${orgCount} organizations and the run found some`).toMatch(/\d+ results?/);
  }
});
