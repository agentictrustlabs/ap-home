/**
 * WHICH NATHAN — the two halves of getting a bare name right.
 *
 * 1. RENDERING. When the agent says several agents answer to a name it sends a `choice` field. The Home
 *    used to ignore the type and render a text box, telling the person "4 agents answer to nathan" and
 *    giving them nowhere to say which. That is a pure UI contract, so it is tested as one: the reply is
 *    stubbed to the shape the agent produces (pinned by the unit tests in
 *    apps/demo-a2a/test/party-resolution.test.ts) and this asserts what the browser does with it.
 *    Stubbed deliberately — with typed narrowing live, a genuinely ambiguous ask is now hard to produce,
 *    which is the feature working and no reason to stop guarding the regression.
 *
 * 2. RESOLUTION. Against the real agent: "send nathan a message" is nathan.me, not his org, team or
 *    treasury — and the card names who it chose before anything is signed.
 */
import { test, expect, type Page } from '@playwright/test';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
const NATHAN_ME = '0x1dba4a27c53d7babda99513080223fb3bfc4bad1';

async function asAlice(page: Page, request: import('@playwright/test').APIRequestContext): Promise<void> {
  const signin = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'alice', client_id: 'demo-jp' } });
  const { homeSession } = (await signin.json()) as { homeSession: string };
  await page.goto(`${HOME}/#session=${homeSession}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('ask-toggle')).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(2_000);
}

test('candidates are SHOWN as choices, and picking one is what gets sent', async ({ page, request }) => {
  await asAlice(page, request);

  const posted: unknown[] = [];
  await page.route('**/harness/ask', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { supplied?: unknown[] };
    posted.push(body);
    // Turn 2 (the answer came back) → done. Turn 1 → the ambiguity.
    if (body.supplied?.length) {
      await route.fulfill({ json: { ok: true, runRef: 'r1', reply: { kind: 'done', runRef: 'r1', result: { sent: true }, receipts: [] } } });
      return;
    }
    await route.fulfill({
      json: {
        ok: true, runRef: 'r1', resumable: true,
        reply: {
          kind: 'prompt', runRef: 'r1', resumeToken: 's0',
          prompt: {
            kind: 'data', stepRef: 's0', toolId: 'messaging.direct.send', prompt: 'Which “nathan” do you mean?',
            fields: [{
              name: 'recipient', label: 'the person to message', type: 'choice', required: true,
              hint: '4 agents you know answer to “nathan” — pick the one you mean',
              choices: [
                { value: NATHAN_ME, label: 'nathan.me', hint: '0x1dba4a…bad1 · the naming service' },
                { value: '0x55b0c86b19812292bfe8a61bf609393c87955f30', label: 'nathan.org', hint: '0x55b0c8…5f30 · the naming service' },
                { value: '0x344ec23c9c60d013518c1af58502133a82c9b98b', label: 'nathan.team', hint: '0x344ec2…b98b · the naming service' },
                { value: '0x2c471607fec409516ab6de6b7517bcf95f1f2edc', label: 'nathan.treasury', hint: '0x2c4716…2edc · the naming service' },
              ],
            }],
          },
        },
      },
    });
  });

  await page.getByTestId('ask-toggle').click();
  await page.getByTestId('ask-input').fill('send nathan a message saying hello');
  await page.getByTestId('ask-input').press('Enter');

  const choices = page.getByTestId('ask-choices-recipient');
  await expect(choices, 'the candidates are rendered, not described').toBeVisible({ timeout: 60_000 });
  const rows = choices.getByRole('radio');
  await expect(rows).toHaveCount(4);

  const texts = await rows.allInnerTexts();
  expect(new Set(texts).size, 'every candidate is distinguishable').toBe(texts.length);
  for (const t of texts) expect(t, 'each candidate shows its address').toMatch(/0x[0-9a-f]{6}/i);

  // Nothing is preselected: the surface does not rank what the resolver refused to rank.
  expect(await rows.evaluateAll((els) => els.filter((e) => e.getAttribute('aria-checked') === 'true').length)).toBe(0);

  const me = rows.filter({ hasText: 'nathan.me' }).first();
  await me.click();
  await expect(me).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('ask-answer').click();

  await expect.poll(() => posted.length, { timeout: 60_000 }).toBe(2);
  const answer = posted[1] as { supplied: Array<{ stepRef: string; data: Record<string, string> }> };
  expect(answer.supplied[0], 'the picked agent is what travels back').toMatchObject({ stepRef: 's0', data: { recipient: NATHAN_ME } });
});

test('a bare name resolves by what the capability ACTS ON, and is named before signing', async ({ page, request }) => {
  await asAlice(page, request);
  await page.getByTestId('ask-toggle').click();
  await page.getByTestId('ask-input').fill('send nathan a message saying hello');
  await page.getByTestId('ask-input').press('Enter');

  // A message goes to the PERSON — not the org, team or treasury that answer to the same word.
  await expect(page.getByTestId('ask-authority')).toBeVisible({ timeout: 120_000 });
  const parties = page.getByTestId('ask-parties');
  await expect(parties, 'who it chose is shown before anyone signs').toBeVisible();
  await expect(parties).toContainText('nathan.me');
  await expect(parties).not.toContainText('nathan.treasury');
});
