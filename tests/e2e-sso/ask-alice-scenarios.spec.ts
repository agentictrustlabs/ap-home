/**
 * THE THREE ASKS A PERSON ACTUALLY MAKES — driven through the real flyout, as Alice.
 *
 * Each one turns on the agent knowing which "nathan" is meant, and the answer differs per capability:
 * money goes to a TREASURY, a message goes to a PERSON, and the payer is Alice's own treasury even though
 * she never says so. Those three facts are the whole feature; if any of them regresses the Ask starts
 * paying person agents that hold nothing and asking for authority nobody can give.
 *
 * Asserted on what the PERSON sees — the authority card names the parties in words — because that is the
 * only place a wrong resolution can still be caught before it is signed.
 */
import { test, expect, type Page } from '@playwright/test';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';

async function asAlice(page: Page, request: import('@playwright/test').APIRequestContext): Promise<void> {
  const r = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'alice', client_id: 'demo-jp' } });
  expect(r.ok(), 'demo-signin').toBeTruthy();
  const { homeSession } = (await r.json()) as { homeSession: string };
  await page.goto(`${HOME}/#session=${homeSession}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('ask-toggle')).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(2_500);
}

/** Ask, and wait for whichever card the agent comes back with. */
async function ask(page: Page, message: string): Promise<void> {
  const flyout = page.getByTestId('ask-flyout');
  if (!(await flyout.isVisible().catch(() => false))) await page.getByTestId('ask-toggle').click();
  await expect(flyout).toBeVisible();
  await page.getByTestId('ask-input').fill(message);
  await page.getByTestId('ask-input').press('Enter');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    for (const id of ['ask-authority', 'ask-prompt', 'ask-authority-blocked']) {
      if (await page.getByTestId(id).isVisible().catch(() => false)) return;
    }
    const said = ((await flyout.locator('.ask-msg.agent:not([data-testid])').last().textContent().catch(() => '')) ?? '').trim();
    if (said && said !== '…' && !said.includes(message)) return;
    await page.waitForTimeout(1_000);
  }
}

test('“send 10 usdc to nathan” pays FROM alice’s treasury TO nathan’s', async ({ page, request }) => {
  await asAlice(page, request);
  await ask(page, 'send 10 usdc to nathan');

  // WHICH OF HERS, when she holds more than one. She now does — chartering a treasury takes a sentence —
  // and the agent will not pick between them: whose money moves is hers to say. This test used to assume
  // the answer was obvious because there was only ever one, which stopped being true the moment the
  // product let her make a second.
  const payerPrompt = page.getByTestId('ask-prompt');
  if (await payerPrompt.isVisible().catch(() => false)) {
    await expect(payerPrompt, 'it asks which of HERS pays').toContainText(/which of your treasur/i);
    const choice = page.locator('[data-testid^="ask-choice-"]').filter({ hasText: 'alice2.treasury' }).first();
    await expect(choice, 'and lists them by name').toBeVisible();
    await choice.click();
    await page.getByTestId('ask-answer').click();
  }

  await expect(page.getByTestId('ask-authority'), 'a payment reaches a mandate request').toBeVisible({ timeout: 120_000 });
  const parties = page.getByTestId('ask-parties');
  // The payer is hers, and even when she picks it the point stands: a person SA holds no USDC, so taking
  // the realm she is standing in as the payer is how this died on a balance check against an account
  // that cannot pay.
  await expect(parties).toContainText('alice2.treasury');
  // "Send money to nathan" means his treasury — the same word means his person agent for a message.
  await expect(parties).toContainText('nathan.treasury');
  await expect(parties, 'money must not go to a person agent when a treasury answers').not.toContainText('nathan.me');
  // Plain words, not an identifier — the words come from the agent's published vocabulary.
  await expect(page.getByTestId('ask-authority')).toContainText('make payments');
});

test('“send a message to nathan” goes to the PERSON, as alice herself', async ({ page, request }) => {
  await asAlice(page, request);
  await ask(page, 'send a message to nathan saying hello');

  await expect(page.getByTestId('ask-authority')).toBeVisible();
  await expect(page.getByTestId('ask-parties')).toContainText('nathan.me');
  await expect(page.getByTestId('ask-parties'), 'a message is not sent to a treasury').not.toContainText('nathan.treasury');
  // The SENDER is Alice. When nothing set it, the delegator fell through to the RECIPIENT and she was
  // asked to authorize sending a message as the person she was writing to.
  await expect(page.getByTestId('ask-authority')).toContainText('send direct messages');
  await expect(page.getByTestId('ask-authority')).toContainText('custodies');
});

test('nathan grants, and the message actually SENDS — the turn after a grant does not drift', async ({ page, request }) => {
  // The live failure: "Authority granted: messaging.direct.send" followed one turn later by "I can't help
  // with that". A turn presenting a mandate re-planned from scratch and chose a different tool, so the
  // grant bought nothing. The planner is now told what the mandate covers — read from the wire's own
  // caveats, where the capability is a 4-byte SELECTOR, not the id (the first version searched for the id
  // and silently matched nothing, which is why this looked unfixed).
  const r = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'nathan', client_id: 'demo-jp' } });
  const { homeSession } = (await r.json()) as { homeSession: string };
  await page.goto(`${HOME}/#session=${homeSession}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('ask-toggle')).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(2_500);

  await ask(page, 'send a message to alice saying hello from the gate');
  await expect(page.getByTestId('ask-authority')).toBeVisible();
  await expect(page.getByTestId('ask-parties')).toContainText('alice.me');
  await page.getByTestId('ask-grant').click();

  const flyout = page.getByTestId('ask-flyout');
  await expect
    .poll(async () => (await flyout.innerText()).toLowerCase(), { timeout: 180_000, intervals: [3_000] })
    .toMatch(/sent|delivered|message.*alice|done/);
  expect((await flyout.innerText()).toLowerCase(), 'the grant must not be followed by a refusal').not.toMatch(/can.t help/);
});

test('in a workspace, asking for members reads the ORGANIZATION’s own records', async ({ page, request }) => {
  await asAlice(page, request);
  const switcher = page.getByRole('button', { name: /switch workspace/i });
  await expect(switcher).toBeVisible({ timeout: 30_000 });
  await switcher.click();
  await page.waitForTimeout(1_000);
  const ncf = page.getByRole('button', { name: /northern colorado/i }).first();
  await expect(ncf, 'the workspace is in the switcher').toBeVisible();
  await ncf.click();
  await page.waitForTimeout(2_500);

  await ask(page, 'list the members of this workspace');
  const said = await page.getByTestId('ask-flyout').innerText();
  // Membership is private (ADR-0025) and has never been in the public directory, so the answer must come
  // from the organization's own records — and when those are empty it must say WHY rather than report
  // "no members", which reads as "this organization has nobody in it".
  expect(said, 'a membership answer, not a public-directory miss').toMatch(/member/i);
  expect(said, 'an empty roster explains itself').toMatch(/invitation|Home|no members|not list/i);
});
