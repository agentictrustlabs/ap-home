/**
 * TWO PEOPLE, ONE UNNAMED TREASURY — spec 338 §7 / ADR-0056, driven as both of them.
 *
 * Alice creates a treasury with NO NAME. That makes it genuinely unreachable: absent from the naming
 * service, from the public directory, and from the on-chain ownership edges (which the backfill leaves
 * unnamed agents out of, because recording "alice holds a treasury at 0x…" would put back the very fact
 * the missing name withholds). Nathan cannot find it, and the Ask says so rather than guessing.
 *
 * So he asks her. She decides — in her own Home, reading who is asking and why — and what she gives him
 * is permission to FIND it. The test then asserts the distinction that makes the whole design work:
 * after the grant he can address the treasury, and he still cannot take anything from it. The payment
 * that follows needs his own mandate, exactly as it did before.
 *
 * Runs as two browser CONTEXTS rather than two tests, because the point is the handover: what Nathan can
 * see changes because of something Alice did, and a test that signed in as one of them could not show it.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { settleAsk } from './ask.js';
import { createPublicClient, http } from 'viem';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
const RPC = process.env.RPC_URL ?? 'https://a2a.faithnet.io/rpc';
const USDC = (process.env.MOCK_USDC ?? '0xdaE09066A2cc32f6203605619137dcF01A9B49Ae') as `0x${string}`;

/** The chain is the only witness that matters for "did the money move". */
async function usdcBalance(agent: string): Promise<bigint> {
  return createPublicClient({ transport: http(RPC) }).readContract({
    address: USDC,
    abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf', args: [agent as `0x${string}`],
  }) as Promise<bigint>;
}

async function signIn(page: Page, request: import('@playwright/test').APIRequestContext, handle: string, path = '/'): Promise<string> {
  const r = await request.post(`${HOME}/connect/demo-signin`, { data: { handle, client_id: 'demo-jp' } });
  expect(r.ok(), `demo-signin ${handle}`).toBeTruthy();
  const { homeSession } = (await r.json()) as { homeSession: string };
  await page.goto(`${HOME}${path}#session=${homeSession}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('ask-toggle')).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(2_500);
  return homeSession;
}

/** Ask, and wait for whichever card comes back. Returns the flyout text. */
async function ask(page: Page, message: string): Promise<string> {
  const flyout = page.getByTestId('ask-flyout');
  if (!(await flyout.isVisible().catch(() => false))) await page.getByTestId('ask-toggle').click();
  await expect(flyout).toBeVisible();
  await page.getByTestId('ask-input').fill(message);
  await page.getByTestId('ask-input').press('Enter');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    for (const id of ['ask-authority', 'ask-prompt', 'ask-authority-blocked']) {
      if (await page.getByTestId(id).isVisible().catch(() => false)) return flyout.innerText();
    }
    const said = ((await flyout.locator('.ask-msg.agent:not([data-testid])').last().textContent().catch(() => '')) ?? '').trim();
    if (said && said !== '…' && !said.includes(message)) return flyout.innerText();
    await page.waitForTimeout(1_000);
  }
  return flyout.innerText();
}

test('an unnamed treasury is unreachable until its owner says otherwise', async ({ browser, request }) => {
  test.setTimeout(600_000);
  const aliceCtx: BrowserContext = await browser.newContext();
  const nathanCtx: BrowserContext = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const nathan = await nathanCtx.newPage();

  try {
    // ── 1. Alice makes a treasury with no name ────────────────────────────────────────────────────
    const aliceToken = await signIn(alice, request, 'alice', '/treasuries');
    const before = await request.get(`${HOME}/connect/related-orgs`, { headers: { authorization: `Bearer ${aliceToken}` } });
    const beforeCount = (((await before.json()) as { orgs?: Array<{ kind?: string }> }).orgs ?? []).filter((o) => o.kind === 'person-treasury').length;

    // The button, not the card: CSS uppercases a treasury card's label, so a text filter over cards can
    // match the wrong one.
    const openCreate = alice.getByRole('button', { name: /Create another treasury|Create personal treasury/ }).first();
    await expect(openCreate, 'the page offers to create another treasury').toBeVisible({ timeout: 30_000 });
    await openCreate.click();
    const unnamed = alice.getByRole('button', { name: /Create without a name/ }).first();
    await expect(unnamed, 'an unnamed treasury is offered — a name is optional for plumbing').toBeVisible();
    await unnamed.click();

    await expect.poll(async () => {
      const r = await request.get(`${HOME}/connect/related-orgs`, { headers: { authorization: `Bearer ${aliceToken}` } });
      return (((await r.json()) as { orgs?: Array<{ kind?: string }> }).orgs ?? []).filter((o) => o.kind === 'person-treasury').length;
    }, { timeout: 240_000, intervals: [5_000] }).toBeGreaterThan(beforeCount);

    const after = await request.get(`${HOME}/connect/related-orgs`, { headers: { authorization: `Bearer ${aliceToken}` } });
    const treasuries = (((await after.json()) as { orgs?: Array<{ kind?: string; orgName?: string; orgAgent: string }> }).orgs ?? [])
      .filter((o) => o.kind === 'person-treasury');
    const nameless = treasuries.find((t) => !String(t.orgName ?? '').includes('.'));
    expect(nameless, 'the new treasury has no name').toBeTruthy();
    console.log(`alice's unnamed treasury: ${nameless!.orgAgent}`);

    // ── 2. Nathan asks her for a way to reach it ──────────────────────────────────────────────────
    // He starts where a person with a treasury starts. That page is also where the grant refresh lives,
    // and he needs it to RECEIVE what she gives him: a grant is written into HIS vault, so his storage
    // has to name the record just as hers did. Both sides of a handover need their own house in order.
    await signIn(nathan, request, 'nathan', '/treasuries');
    await nathan.waitForTimeout(8_000);
    const asked = await ask(nathan, 'ask alice.me for a way to pay her treasury because I owe her for lunch');
    console.log(`NATHAN ASKED →\n${asked.split('\n').filter(Boolean).slice(-8).join('\n')}`);
    expect(asked.toLowerCase(), 'the request is an action, not a paragraph').toMatch(/authority|grant|request/);
    await expect(nathan.getByTestId('ask-authority'), 'asking is an act of his, so it takes a mandate').toBeVisible();
    await nathan.getByTestId('ask-grant').click();
    await nathan.waitForTimeout(20_000);
    const afterGrant = await nathan.getByTestId('ask-flyout').innerText();
    console.log(`NATHAN AFTER GRANT →\n${afterGrant.split('\n').filter(Boolean).slice(-8).join('\n')}`);

    // ── 3. Alice decides, in her own Home ─────────────────────────────────────────────────────────
    await alice.reload({ waitUntil: 'domcontentloaded' });
    await alice.waitForTimeout(3_000);
    const card = alice.locator('[data-testid^="resolution-request-"]').first();
    await expect(card, 'the request is waiting for her as a decision').toBeVisible({ timeout: 60_000 });
    const cardText = await card.innerText();
    expect(cardText, 'it says what approving does NOT do').toMatch(/not be able to take/i);
    // Give them the UNNAMED one specifically — that is the whole point of the exchange, and the first
    // version of this test never checked WHICH agent was disclosed, so it passed while handing over the
    // wrong one.
    const picker = card.locator('select');
    await expect(picker, 'several treasuries ⇒ she must choose').toBeVisible();
    await picker.selectOption(nameless!.orgAgent.toLowerCase());
    await expect(picker).toHaveValue(nameless!.orgAgent.toLowerCase());
    await card.getByRole('button', { name: /Give them a way to reach it/ }).click();
    await expect.poll(async () => (await alice.locator('body').innerText()), { timeout: 120_000, intervals: [4_000] })
      .not.toContain('Someone wants a way to reach your treasury');

    // WHAT SHE GRANTED IS WHAT SHE PICKED — asserted where it is actually decided.
    //
    // Not against his held record: that no longer carries an address. He holds a REFERENCE, and the
    // address comes from the resolver each time, which is what lets her withdraw it later. So the check
    // is the one that matters — present the reference and see what the gate projects.
    const nathanSignin = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'nathan', client_id: 'demo-jp' } });
    const nathanToken = ((await nathanSignin.json()) as { homeSession: string }).homeSession;
    const aliceSa = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11';
    await expect.poll(async () => {
      const g = await request.get(`${HOME}/a2a/resolution/grants`, { headers: { authorization: `Bearer ${nathanToken}` } });
      const held = ((await g.json()) as { grants?: Array<{ grantId?: string; owner?: string }> }).grants ?? [];
      return held.filter((x) => String(x.owner ?? '').toLowerCase() === aliceSa).length;
    }, { timeout: 120_000, intervals: [4_000] }).toBeGreaterThan(0);
    // WHICH agent she disclosed is asserted by the CHAIN at the end of this test: the balance that moves
    // is the unnamed treasury's. Nothing here can check it from his side — that is the point of the
    // resolver gate, and reading it back through the gate would need a CSRF ceremony this fixture has no
    // reason to perform when a better assertion already exists.
    console.log(`nathan holds a reference from alice; which agent it opens is proved by the balance below`);

    // ── 4. Nathan pays it — and the grant is not what let him ────────────────────────────────────
    await nathan.reload({ waitUntil: 'domcontentloaded' });
    await nathan.waitForTimeout(3_000);
    const balanceBefore = await usdcBalance(nameless!.orgAgent);
    const paid = await ask(nathan, 'send 1 usdc to alice');
    // Her unnamed treasury is among what he can reach now, listed under HER name because it has none.
    expect(paid.toLowerCase()).toMatch(/authority|which/);

    // Pick it, if he is asked which of hers.
    const choices = nathan.getByTestId('ask-choices-payee');
    if (await choices.isVisible().catch(() => false)) {
      const row = choices.getByRole('radio').filter({ hasText: nameless!.orgAgent.slice(0, 8) }).first();
      await expect(row, 'the granted treasury is offered by name of its owner').toBeVisible();
      await row.click();
      await nathan.getByTestId('ask-answer').click();
    }

    // THE GRANT WAS NOT AUTHORITY. He knows where to send; sending still takes his own mandate.
    await expect(nathan.getByTestId('ask-authority'), 'knowing the address is not permission to pay').toBeVisible({ timeout: 120_000 });
    // It is named by its OWNER, because it has no name of its own — that is what the grant bought.
    await expect(nathan.getByTestId('ask-parties')).toContainText("alice.me's treasury");
    await nathan.getByTestId('ask-grant').click();

    // A PAYMENT IS HIGH RISK, so the ladder demands a second party — and here that is him again, in his
    // own Home. Signing it is part of the flow, not an obstacle to route around: the run re-verifies
    // after the approval discharges the obligation.
    expect(await settleAsk(nathan), 'the run finished rather than stalling on an unanswered obligation').toBe('settled');
    console.log(`PAYMENT FLYOUT →\n${(await nathan.getByTestId('ask-flyout').innerText()).split('\n').filter(Boolean).slice(-6).join('\n')}`);
    await expect
      .poll(async () => (await usdcBalance(nameless!.orgAgent)).toString(), { timeout: 240_000, intervals: [6_000] })
      .not.toBe(balanceBefore.toString());
    console.log(`unnamed treasury balance: ${balanceBefore} → ${await usdcBalance(nameless!.orgAgent)}`);
  } finally {
    await aliceCtx.close();
    await nathanCtx.close();
  }
});
