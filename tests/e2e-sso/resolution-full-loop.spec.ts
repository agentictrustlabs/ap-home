/**
 * THE WHOLE EXCHANGE, WITH BOTH PEOPLE DOING THEIR PART — spec 338 §7 / ADR-0056.
 *
 * Nathan tries to pay Bob. Bob has no treasury at all, so there is nothing to route to and nothing to
 * disclose — the request is not "tell me where it is" but "please have one". He creates it in his own
 * Home, answers, and Nathan finishes the payment he started, in one press, from a card that remembers
 * what he was trying to do.
 *
 * What this proves that the shorter scenario cannot: the flow survives a gap of human action in the
 * middle. Every step is somebody deciding something, and the state that carries across those decisions —
 * the pending amount, the delivered grant, the message that says an answer arrived — is the actual
 * product. The authority story is unchanged throughout: a grant says WHERE, and the payment still takes
 * Nathan's own mandate and the second party a payment's risk demands.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { settleAsk } from './ask.js';
import { createPublicClient, http } from 'viem';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
const RPC = process.env.RPC_URL ?? 'https://a2a.faithnet.io/rpc';
const USDC = (process.env.MOCK_USDC ?? '0xdaE09066A2cc32f6203605619137dcF01A9B49Ae') as `0x${string}`;
const BOB = '0x8c5cddca27c088a65e58e94403acdc9bc3eb7fe3';

const balance = async (agent: string): Promise<bigint> =>
  createPublicClient({ transport: http(RPC) }).readContract({
    address: USDC,
    abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf', args: [agent as `0x${string}`],
  }) as Promise<bigint>;

async function signIn(page: Page, request: import('@playwright/test').APIRequestContext, handle: string, path = '/'): Promise<string> {
  const r = await request.post(`${HOME}/connect/demo-signin`, { data: { handle, client_id: 'demo-jp' } });
  expect(r.ok(), `demo-signin ${handle}`).toBeTruthy();
  const { homeSession } = (await r.json()) as { homeSession: string };
  await page.goto(`${HOME}${path}#session=${homeSession}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('ask-toggle')).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(3_000);
  return homeSession;
}

/** Type an ask and wait for a card or a reply. */
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

test('bob has no treasury: he makes one, answers, and nathan finishes the payment', async ({ browser, request }) => {
  test.setTimeout(900_000);
  const bobCtx: BrowserContext = await browser.newContext();
  const nathanCtx: BrowserContext = await browser.newContext();
  const bob = await bobCtx.newPage();
  const nathan = await nathanCtx.newPage();

  try {
    // Bob's Home has to be able to RECEIVE a request; his storage must name the record.
    const bobToken = await signIn(bob, request, 'bob', '/treasuries');
    await bob.waitForTimeout(10_000);
    const treasuriesOf = async (token: string): Promise<Array<{ orgAgent: string; orgName?: string }>> => {
      const r = await request.get(`${HOME}/connect/related-orgs`, { headers: { authorization: `Bearer ${token}` } });
      return (((await r.json()) as { orgs?: Array<{ kind?: string; orgAgent: string; orgName?: string }> }).orgs ?? [])
        .filter((o) => o.kind === 'person-treasury');
    };
    // What he holds BEFORE. The point of the test is the human step in the middle — he makes one in
    // response to being asked — and pinning it to "he owns nothing" made it a test that could only pass
    // once, on an estate that remembers everything.
    const bobBefore = new Set((await treasuriesOf(bobToken)).map((t) => t.orgAgent.toLowerCase()));

    // ── 1. Nathan tries to pay him, and cannot ───────────────────────────────────────────────────
    await signIn(nathan, request, 'nathan', '/treasuries');
    await nathan.waitForTimeout(8_000);
    await ask(nathan, 'send bob 3 usdc');
    const prompt = nathan.getByTestId('ask-prompt');

    // ── 2. The way out — asserted when it is genuinely there ─────────────────────────────────────
    //
    // The demo estate remembers: once Bob has ANY treasury and Nathan holds a grant for it, "send bob 3
    // usdc" routes and the dead end never appears. That is the feature working, and a test that demanded
    // the dead end could only pass on a first run. So the suggestion is asserted when the dead end
    // occurs, and the same ask it would have produced is typed when it does not — either way the rest of
    // the loop runs, which is the part with two people in it.
    const deadEnd = await prompt.isVisible().catch(() => false) && /is a treasury/.test(await prompt.innerText().catch(() => ''));
    if (deadEnd) {
      const suggest = nathan.getByTestId('ask-suggest');
      await expect(suggest, 'the dead end offers the ask that gets past it').toBeVisible();
      await expect(suggest).toContainText(/Ask bob/i);
      await suggest.click();
      // PREFILLED, not sent: he presses send himself.
      await expect(nathan.getByTestId('ask-input')).toHaveValue(/ask bob .*treasury/i);
      await expect(nathan.getByTestId('ask-input'), 'and it remembers the amount').toHaveValue(/3 usdc/i);
    } else {
      console.log('bob is already reachable — driving the request the suggestion would have produced');
      await nathan.getByTestId('ask-flyout').getByRole('button', { name: /Not now|Cancel/ }).first().click().catch(() => undefined);
      await nathan.getByTestId('ask-input').fill('ask bob for a way to pay their treasury so I can send 3 usdc');
    }
    await nathan.getByTestId('ask-input').press('Enter');
    await expect(nathan.getByTestId('ask-authority'), 'asking is an act of his').toBeVisible({ timeout: 120_000 });
    await nathan.getByTestId('ask-grant').click();
    // A PENDING one. Counting every request counted the one he answered last run, so this passed
    // instantly and the card was looked for before the new ask had arrived.
    await expect
      .poll(async () => {
        const r = await request.get(`${HOME}/a2a/resolution/requests`, { headers: { authorization: `Bearer ${bobToken}` } });
        const rows = ((await r.json()) as { requests?: Array<{ requester?: string; status?: string; kind?: string }> }).requests ?? [];
        return rows.filter((x) => x.kind !== 'resolution.invitation.sent' && (x.status ?? 'pending') === 'pending').length;
      }, { timeout: 240_000, intervals: [5_000] }).toBeGreaterThan(0);

    // ── 3. Bob has nothing to give — so he makes one ─────────────────────────────────────────────
    await bob.reload({ waitUntil: 'domcontentloaded' });
    await bob.waitForTimeout(6_000);
    const card = bob.locator('[data-testid^="resolution-request-"]').first();
    await expect(card, 'the request is waiting for him').toBeVisible({ timeout: 60_000 });
    // When he owns nothing of the kind, the card says so and offers the way out rather than only refusing.
    if (!bobBefore.size) {
      await expect(card, 'it says he has none, rather than only refusing').toContainText(/You have no treasury yet/i);
    }

    // He makes one, unnamed — in response to being asked, which is the human step this test exists for.
    await bob.getByRole('button', { name: /Create personal treasury|Create another treasury/ }).first().click();
    await bob.getByRole('button', { name: /Create without a name/ }).first().click();
    await expect
      .poll(async () => (await treasuriesOf(bobToken)).filter((t) => !bobBefore.has(t.orgAgent.toLowerCase())).length,
        { timeout: 300_000, intervals: [6_000] })
      .toBeGreaterThan(0);
    const bobTreasury = (await treasuriesOf(bobToken)).find((t) => !bobBefore.has(t.orgAgent.toLowerCase()))!.orgAgent.toLowerCase();
    console.log(`bob's new treasury: ${bobTreasury}`);

    // ── 4. Now he can answer ─────────────────────────────────────────────────────────────────────
    await bob.reload({ waitUntil: 'domcontentloaded' });
    await bob.waitForTimeout(6_000);
    const card2 = bob.locator('[data-testid^="resolution-request-"]').first();
    await expect(card2).toBeVisible({ timeout: 60_000 });
    // HIS NEW TREASURY HAS TO REACH THE CARD before he can offer it: the list is read from his own tree,
    // which the create only just wrote to, and the button is disabled precisely because the card does not
    // know about it yet. Waiting for the card to be ABLE to answer is the honest wait; pressing a disabled
    // button and timing out reports a broken approval for what is a slow read.
    const picker = card2.locator('select');
    const approve = card2.getByRole('button', { name: /Give them a way to reach it/ });
    await expect.poll(async () => {
      if (await picker.isVisible().catch(() => false)) {
        // Only his newest one will do — it is the agent this whole test is about.
        await picker.selectOption(bobTreasury).catch(() => undefined);
      }
      return approve.isEnabled().catch(() => false);
    }, { timeout: 180_000, intervals: [4_000] }).toBe(true);
    await approve.click();

    // WHAT HE GRANTED REACHED NATHAN — as a reference, which is all a holder gets now: the address comes
    // from the resolver per use, so his record cannot be asked which agent it opens. Which one it is gets
    // proved by the balance at the end of this test, where it cannot be faked.
    const nathanToken = (await (await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'nathan', client_id: 'demo-jp' } })).json() as { homeSession: string }).homeSession;
    await expect.poll(async () => {
      const g = await request.get(`${HOME}/a2a/resolution/grants`, { headers: { authorization: `Bearer ${nathanToken}` } });
      const held = ((await g.json()) as { grants?: Array<{ owner?: string; issuedAt?: string }> }).grants ?? [];
      return held.filter((x) => String(x.owner ?? '').toLowerCase() === BOB).length;
    }, { timeout: 180_000, intervals: [5_000] }).toBeGreaterThan(0);

    // ── 5. Nathan finishes what he started, from a card that remembered it ───────────────────────
    const before = await balance(bobTreasury);
    await nathan.reload({ waitUntil: 'domcontentloaded' });
    await nathan.waitForTimeout(8_000);
    // Found by WHOSE grant it is, not which agent it opens — the card cannot name the agent, because the
    // holder does not hold its address. `.last()`: he may hold several from the same person.
    const ready = nathan.locator(`[data-testid^="ready-to-send-"][data-owner="${BOB}"]`).last();
    await expect(ready, 'his Home says an answer arrived, and what it was for').toBeVisible({ timeout: 120_000 });
    await expect(ready, 'including the amount he never had to remember').toContainText('3');
    // Captured while it is still on screen: after the payment it is gone, which is the point of §6.
    const readyCard = (await ready.getAttribute('data-testid')) as string;
    await ready.getByRole('button', { name: /Send/ }).click();

    // Prefilled, then sent by him — and the payment takes its own authority, as always.
    await expect(nathan.getByTestId('ask-input')).toHaveValue(/3 usdc/i);
    await nathan.getByTestId('ask-input').press('Enter');

    // He may be asked WHICH of Bob's treasuries — several have been disclosed to him over time, and the
    // agent will not pick between them. Name the one Bob just made, by typing it: it has no name of its
    // own, which is the entire reason a grant was needed.
    const which = nathan.getByTestId('ask-prompt');
    await expect(which.or(nathan.getByTestId('ask-authority')).first()).toBeVisible({ timeout: 180_000 });
    if (await which.isVisible().catch(() => false)) {
      const other = nathan.getByTestId('ask-other-payee');
      if (await other.isVisible().catch(() => false)) await other.fill(bobTreasury);
      else await nathan.locator(`[data-testid="ask-choice-${bobTreasury}"]`).click();
      await nathan.getByTestId('ask-answer').click();
    }
    await expect(nathan.getByTestId('ask-authority'), 'the grant told him where, not whether').toBeVisible({ timeout: 180_000 });
    await nathan.getByTestId('ask-grant').click();
    // The ladder asks for a second party on a payment, and each turn re-runs every gate — including, now,
    // a resolver call per candidate. This test also charters an agent on chain first, so the whole thing
    // is genuinely long; the window is sized for the work rather than for how long it "should" take.
    expect(await settleAsk(nathan), 'the run finished rather than stalling on an unanswered obligation').toBe('settled');

    console.log(`FINAL FLYOUT →\n${(await nathan.getByTestId('ask-flyout').innerText()).split('\n').filter(Boolean).slice(-8).join('\n')}`);
    await expect.poll(async () => (await balance(bobTreasury)).toString(), { timeout: 420_000, intervals: [10_000] })
      .not.toBe(before.toString());
    console.log(`bob's treasury: ${before} → ${await balance(bobTreasury)}`);

    // ── 6. AND THE TASK IS FINISHED ──────────────────────────────────────────────────────────────
    // The note that remembered what he was sending has nothing left to wait on, so the card stops asking —
    // without a reload, because the Ask says a run finished and this list listens. A card that keeps
    // offering a payment already made is the one mistake a "finish this" affordance must never invite.
    // The GRANT is untouched: he can still send there by name. What ended is the task, not the disclosure.
    await expect(nathan.getByTestId(readyCard), 'the card stops offering a payment already made').toHaveCount(0, { timeout: 180_000 });
  } finally {
    await bobCtx.close();
    await nathanCtx.close();
  }
});
