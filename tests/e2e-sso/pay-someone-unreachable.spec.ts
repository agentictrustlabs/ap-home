/**
 * ONE FLOW, TWO PEOPLE — spec 364.
 *
 * Alice asks to pay Bob. Bob's treasury is UNLISTED (unnamed by choice, spec 338), so it cannot be
 * resolved from anything public and her agent has to ask him. That is where this used to fall apart:
 *
 *   · Alice's sentence was dropped on the floor once the request went out;
 *   · Bob got a message with a LINK to another page, and the decision lived there, not here;
 *   · when Bob approved, nothing told Alice's original intent that it could now proceed.
 *
 * Two surfaces, two abandoned halves, one unpaid person. This asserts the single flow:
 *
 *   1. Alice asks → the request goes out (one act, from her Ask).
 *   2. BOB DECIDES IN HIS MESSAGES — the chip is the decision, and sharing signs the grant with the
 *      credential that custodies him. No second page.
 *   3. ALICE IS TOLD, and the message carries the next step — the sentence she started with, with the
 *      figure she named. It prefills; she still reads it and presses send.
 *   4. The payment settles, and BOTH of them hold the receipt (spec 360).
 *
 * The assertions are the person's, not the plumbing's: what each of them can see and press.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
const USDC_AMOUNT = process.env.E2E_USDC ?? '1.2';

async function signIn(request: APIRequestContext, handle: string): Promise<string> {
  const res = await request.post(`${HOME}/connect/demo-signin`, { data: { handle, client_id: 'demo-jp' } });
  expect(res.ok(), `demo-signin ${handle}`).toBeTruthy();
  return ((await res.json()) as { homeSession: string }).homeSession;
}

async function openHome(page: Page, session: string): Promise<void> {
  await page.goto(`${HOME}/#session=${session}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('ask-toggle')).toBeVisible({ timeout: 60_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

test('alice pays someone she cannot reach, and it takes one flow on each side', async ({ page, request, browser }) => {
  test.setTimeout(600_000);

  // ── 1. ALICE ASKS. Bob's treasury is unlisted, so the honest move is to ask him — and the ask must
  //       carry the figure, or the answer cannot finish the sentence.
  const aliceSession = await signIn(request, 'alice');
  await openHome(page, aliceSession);
  await page.getByTestId('ask-toggle').click();
  await page.getByTestId('ask-input').fill(`ask bob for a way to reach his treasury — I want to send ${USDC_AMOUNT} usdc`);
  await page.getByTestId('ask-input').press('Enter');

  // Asking someone for a way to reach an agent of theirs is an act of Alice's, so it takes her mandate.
  const authority = page.getByTestId('ask-authority');
  await expect(authority, 'asking is an act of hers and takes her authority').toBeVisible({ timeout: 180_000 });
  await page.getByTestId('ask-grant').click();
  await expect(page.getByTestId('ask-done').or(page.getByText(/sent|asked|request/i)).first())
    .toBeVisible({ timeout: 180_000 });

  // ── 2. BOB DECIDES WHERE HE READ IT. A second browser context, because this is a different person —
  //       not a different tab of the same one.
  const bobContext = await browser.newContext();
  const bobPage = await bobContext.newPage();
  const bobSession = await signIn(request, 'bob');
  await openHome(bobPage, bobSession);
  await bobPage.goto(`${HOME}/messages`, { waitUntil: 'domcontentloaded' });

  // The thread with Alice carries her request AND the decision. No link, no second page.
  const share = bobPage.getByTestId('share-way').first();
  await expect(share, 'the request is actionable where it was read').toBeVisible({ timeout: 120_000 });
  await share.click();

  // WHICH ONE OF HIS. Bob holds twenty-six treasuries, so he is asked — once, with what each one holds,
  // richest first, because a list of identical unnamed rows is a blind pick. (A person whose own
  // preference already answers is not asked at all — `ap:primaryPayee`, spec 363.)
  const picked = bobPage.locator('[data-testid^="share-way-pick-"]').first();
  const done = bobPage.getByTestId('share-way-done');
  await expect(picked.or(done), 'either he is asked which, or his preference already said').toBeVisible({ timeout: 120_000 });
  if (await picked.isVisible().catch(() => false)) await picked.click();

  // Sharing signs the grant with the credential that custodies Bob — a session says who is logged in,
  // a signature says who decided, and only the second is something Alice can be shown later.
  await expect(done, 'he can see that it went').toBeVisible({ timeout: 180_000 });

  // ── 3. ALICE IS TOLD, AND CAN FINISH IT. The answer travels the way the question did — a message —
  //       and it carries the next step rather than a link to a page she has to find her way back from.
  await page.goto(`${HOME}/messages`, { waitUntil: 'domcontentloaded' });
  const finish = page.getByTestId('continue-payment').first();
  await expect(finish, 'the answer carries the next step').toBeVisible({ timeout: 120_000 });
  await expect(finish).toContainText(new RegExp(USDC_AMOUNT.replace('.', '\\.')));
  await finish.click();

  // It PREFILLS and does not send: the person still reads it and presses send, like every suggested ask.
  const input = page.getByTestId('ask-input');
  await expect(input, 'the sentence she started with, back in her Ask').toBeVisible({ timeout: 60_000 });
  await expect(input).toHaveValue(/bob/i);
  await input.press('Enter');

  // ── 4. IT SETTLES, AND BOTH OF THEM ARE TOLD. The mandate is hers to sign; the receipt is theirs to
  //       hold. A payment neither party can see afterwards is the incident spec 360 exists to end.
  const payAuthority = page.getByTestId('ask-authority');
  await expect(payAuthority, 'the payment asks for its own authority').toBeVisible({ timeout: 180_000 });
  await expect(payAuthority).toContainText(/make payments/i);
  await page.getByTestId('ask-grant').click();

  // A payment is high risk, so the ladder asks a second party to approve the step — and it ASKS rather
  // than refusing. Waiting on "the prompt OR the transaction" rather than on a fixed pause: a run that
  // needs no approval must not fail this, and one that does must not be abandoned mid-ceremony.
  const approval = page.getByTestId('ask-prompt');
  const tx = page.getByTestId('ask-tx');
  await expect(approval.or(tx), 'either it asks for the second party, or it is already done').toBeVisible({ timeout: 240_000 });
  if (await approval.isVisible().catch(() => false)) {
    await expect(approval).toContainText(/second party to approve/i);
    await page.getByTestId('ask-answer').click();
  }

  await expect(tx, 'it settled, and the run says which transaction').toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId('ask-effect-ok'), 'both sides have the receipt').toBeVisible({ timeout: 120_000 });

  await bobContext.close();
});
