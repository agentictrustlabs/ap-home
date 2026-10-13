import { test, expect, type Page } from '@playwright/test';
import { onboard } from './onboard';

// spec 341 §5.1b — A SENDS TO B OVER A2A. The first end-to-end coverage of the send path, added
// because the cutover moved it: the Home used to write into the recipient's vault directly, and now
// the sender's own agent signs an A2A `message/send` under a wire the sender approved.
//
// WHY AN E2E AND NOT MORE UNIT TESTS. Both ends are unit-covered — the sender builds what the gate
// wants, the gate wants what the sender builds — and that is exactly the pair of tests that can both
// pass while the seam between them is wrong. What only a live run proves: the deployment's KMS
// session key can actually sign, the person's custody credential can sign a wire that ERC-1271-
// verifies against their SA, `isRevoked` answers, and the recipient's DO holds a delivery wire for
// its own vault. Four systems that no stub can stand in for.
//
// The assertions are ordered so a failure NAMES its stage: the approval affordance appearing at all
// means the agent refused for the resolvable reason; the message landing in B's inbox means the far
// gate passed. A run that stops between them has isolated the problem to the gate.

async function bodyOf(p: Page): Promise<string> {
  return (await p.locator('body').innerText().catch(() => '')).replace(/\n+/g, ' | ');
}
async function shot(p: Page, n: string): Promise<void> {
  await p.screenshot({ path: `artifacts/send-${n}.png`, fullPage: true }).catch(() => {});
}
function httpLog(p: Page, who: string): void {
  p.on('response', async (r) => {
    const u = r.url();
    if (/\/(connect|a2a)\//.test(u) && r.status() >= 400) {
      console.log(`[${who} http-${r.status()}] ${u.replace(/https:\/\/[a-z0-9.-]+\.faithnet\.(me|io|ai)/, '')} :: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    }
  });
}

test('A messages B: approve once, then the agent delivers over A2A', async ({ browser }) => {
  test.setTimeout(900_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  httpLog(pageA, 'A');
  httpLog(pageB, 'B');

  const stamp = Date.now().toString(36);
  const nameA = 'send' + stamp;
  const nameB = 'recv' + stamp;
  const bodyText = `hello from ${nameA} at ${stamp}`;

  // B first — A searches for them by name, and the discovery index needs the registration to land.
  const B = await onboard(pageB, nameB);
  const A = await onboard(pageA, nameA);
  console.log(`A=${A.name} ${A.address}  B=${B.name} ${B.address}`);

  // ── A composes ────────────────────────────────────────────────────────────────────────────────
  await pageA.goto(`${A.origin}/messages`);

  // Open compose by its ACCESSIBLE NAME and do not swallow the failure. The control is a `✎` glyph,
  // so there is no text to match on; the previous version clicked it inside a `.catch()` and, when
  // the click missed, spent its timeout on a recipient field that had never been rendered — and then
  // reported that as a messaging failure. Same trap the send button below already carries a note about.
  const compose = pageA.getByRole('button', { name: /^New message$/i }).first();
  await expect(compose, 'the compose control must be on the messages page').toBeVisible({ timeout: 60_000 });
  await compose.click();

  // Wait for the PICKER, not for a placeholder regex loose enough to match the rail's own filter box.
  const picker = pageA.getByTestId('dm-picker');
  await expect(picker, 'compose must open the recipient picker').toBeVisible({ timeout: 30_000 });
  await shot(pageA, 'A-compose-open');

  // The To: field is a typeahead — there is no Search button to press any more.
  await pageA.getByTestId('dm-compose-to').fill(nameB);

  // A just-claimed name can lag in the KB; the send cannot proceed without a resolved recipient, and
  // a test that pressed on regardless would report a messaging failure for a discovery delay. Match
  // the row by B's ADDRESS, which is B's identity (ADR-0010) — a name is a facet that may not have
  // propagated yet, and matching on page text would happily hit the query echoed in the input.
  const rowB = picker.locator(`[data-testid="dm-recipient-${B.address}" i]`);
  await expect(rowB, `B (${nameB} / ${B.address}) never appeared in A's recipient search — discovery, not messaging`)
    .toBeVisible({ timeout: 120_000 });
  await shot(pageA, 'A-search');

  await rowB.click();
  const composer = pageA.getByPlaceholder(/Write your message/i).first();
  await composer.fill(bodyText);
  // A CLICK THAT SILENTLY MISSES is how the first run of this test "passed" its way to a wrong
  // conclusion: the control is a `➤` glyph, so `name: /^Send$/` matched nothing, `.catch()` swallowed
  // it, and the absent approval banner looked like a product failure. Asserted, never swallowed.
  // Accepts either the accessible name or the raw glyph, so the test does not depend on which
  // Home build is live — it asserts the CONTROL exists, which is the property that matters.
  const sendBtn = pageA.locator('button.chat-send-btn, button[aria-label="Send message"]').first();
  await expect(sendBtn).toBeVisible({ timeout: 15_000 });
  await sendBtn.click();
  await pageA.waitForTimeout(6000);
  await shot(pageA, 'A-first-send');

  // ── The refusal is the expected first outcome ─────────────────────────────────────────────────
  // A has never approved messaging, so their agent holds no wire and MUST refuse. The affordance
  // appearing is the proof that it refused for the resolvable reason rather than failing.
  const approve = pageA.getByRole('button', { name: /^Approve$/ }).first();
  const needsApproval = await approve.count().then((c) => c > 0);
  console.log('approval affordance shown:', needsApproval, '|', (await bodyOf(pageA)).slice(0, 240));
  expect(needsApproval, 'no wire, but no approval affordance — the agent refused for some other reason').toBe(true);

  await approve.click();
  // The person signs here (mock SIWE wallet auto-approves), then the wire is verified on-chain by
  // the agent — ERC-1271 plus an isRevoked read — before it is custodied.
  for (let i = 0; i < 24; i++) {
    await pageA.waitForTimeout(5000);
    if ((await approve.count()) === 0) break;
  }
  await shot(pageA, 'A-approved');
  expect(await approve.count(), 'approval never completed — the wire was rejected at the agent').toBe(0);

  // ── Send again, now under the wire ────────────────────────────────────────────────────────────
  // Not swallowed either: if the composer or the send control is gone after approval, that IS the
  // finding — silently skipping the second send would leave the assertion below blaming delivery.
  await expect(composer, 'the composer must survive the approval round trip').toBeVisible({ timeout: 30_000 });
  await composer.fill(bodyText);
  await expect(sendBtn).toBeVisible({ timeout: 15_000 });
  await sendBtn.click();
  let sent = false;
  for (let i = 0; i < 12; i++) {
    await pageA.waitForTimeout(5000);
    if (new RegExp(bodyText.slice(0, 20), 'i').test(await bodyOf(pageA))) { sent = true; break; }
  }
  await shot(pageA, 'A-sent');
  console.log('A sender copy visible:', sent, '|', (await bodyOf(pageA)).slice(0, 240));
  expect(sent, "A's own copy never appeared — the send was rejected after approval").toBe(true);

  // ── B receives ────────────────────────────────────────────────────────────────────────────────
  // The whole point: this arrived through B's A2A gate and was admitted into B's vault by B's own
  // DO. Nothing in A's Home wrote it.
  await pageB.goto(`${B.origin}/messages`);
  let received = false;
  for (let i = 0; i < 16; i++) {
    await pageB.waitForTimeout(5000);
    if (new RegExp(bodyText.slice(0, 20), 'i').test(await bodyOf(pageB))) { received = true; break; }
    await pageB.reload().catch(() => {});
  }
  await shot(pageB, 'B-inbox');
  console.log('B received:', received, '|', (await bodyOf(pageB)).slice(0, 240));
  expect(received, "B never received it — the A2A delivery did not land in B's vault").toBe(true);
});
