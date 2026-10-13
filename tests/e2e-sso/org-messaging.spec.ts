import { test, expect, type Page } from '@playwright/test';
import { onboard } from './onboard';

// spec 341 §5.1c — AN ORGANIZATION SENDS. The person case is covered by `messaging-send.spec.ts`;
// this covers the half that needed its own ceremony.
//
// WHAT IS ACTUALLY DIFFERENT, and why a second e2e rather than a parameter on the first: an org has no
// session and no key. Sending as one exercises a chain nothing in the person path touches — the
// steward's credential producing a signature the ORG's account validates through its custody module,
// the org→person stewardship delegation being re-verified at the agent (delegator is the org, delegate
// is the caller, stewardship SHAPE not merely member access), and the org's own transport grant and
// signing wire being custodied against the org principal rather than the person's.
//
// The invite is sent from the ORG'S workspace Messages, which is the surface a steward actually uses.

async function bodyOf(p: Page): Promise<string> {
  return (await p.locator('body').innerText().catch(() => '')).replace(/\n+/g, ' | ');
}
async function shot(p: Page, n: string): Promise<void> {
  await p.screenshot({ path: `artifacts/orgmsg-${n}.png`, fullPage: true }).catch(() => {});
}
function httpLog(p: Page, who: string): void {
  p.on('response', async (r) => {
    const u = r.url();
    if (/\/(connect|a2a)\//.test(u) && r.status() >= 400) {
      console.log(`[${who} http-${r.status()}] ${u.replace(/https:\/\/[a-z0-9.-]+\.faithnet\.(me|io|ai)/, '')} :: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    }
  });
}

test('an organization sends: steward approves once, the org delivers over A2A', async ({ browser }) => {
  test.setTimeout(900_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  httpLog(pageA, 'steward');
  httpLog(pageB, 'member');

  const stamp = Date.now().toString(36);
  const nameA = 'stew' + stamp;
  const nameB = 'mem' + stamp;
  const orgName = 'org' + stamp;

  const B = await onboard(pageB, nameB);
  const A = await onboard(pageA, nameA);
  console.log(`steward=${A.name} ${A.address}  member=${B.name} ${B.address}`);

  // ── The steward creates an org ────────────────────────────────────────────────────────────────
  // NAVIGATE BY CLICKING, not `goto`. A fresh navigation to the handle subdomain can land back on the
  // entry experience while the just-created home settles, and the test then reports a messaging
  // failure for an onboarding race. `two-user.spec.ts` clicks through for the same reason.
  await pageA.getByRole('link', { name: /^Organizations$/ }).first().click().catch(() => {});
  await pageA.waitForTimeout(5000);
  await shot(pageA, 'orgs-page');
  await pageA.getByRole('button', { name: 'Create organization', exact: true }).first().click().catch(() => {});
  await pageA.waitForTimeout(1500);
  const orgInput = pageA.locator('input:visible').first();
  await expect(orgInput, 'the org-create form never opened — onboarding likely did not settle').toBeVisible({ timeout: 30_000 });
  await orgInput.fill(orgName);
  await pageA.getByRole('button', { name: /Create \+ name|^Create$/i }).first().click().catch(() => {});

  let orgAddr: string | undefined;
  for (let i = 0; i < 16; i++) {
    await pageA.waitForTimeout(5000);
    const b = await bodyOf(pageA);
    if (/went wrong|AA31|too low/i.test(b)) { console.log('org-create ERROR:', b.slice(0, 200)); break; }
    if (new RegExp(orgName, 'i').test(b)) {
      // The FULL address appears only in the explorer link. The card renders it truncated
      // (`0x77b5…6e97`) in a copy button, and a truncated address silently produces a request for an
      // agent that does not exist.
      const href = await pageA.locator('a[href*="basescan.org/address/0x"]').first().getAttribute('href').catch(() => null);
      orgAddr = href?.match(/0x[0-9a-fA-F]{40}/)?.[0];
      if (orgAddr) break;
    }
  }
  await shot(pageA, 'org-created');
  // Org creation is a precondition, not the subject. Failing here says nothing about messaging, so it
  // says so rather than reporting a messaging failure.
  expect(orgAddr, 'the org was never created — precondition, not a messaging result').toBeTruthy();
  console.log('ORG', orgName, orgAddr);

  // ── Send from the ORG's workspace Messages ────────────────────────────────────────────────────
  await pageA.goto(`${A.origin}/org/${orgAddr}/messages`);
  await pageA.waitForTimeout(8000);
  await shot(pageA, 'org-messages');

  const search = pageA.getByPlaceholder(/Search people|name|who/i).first();
  await expect(search).toBeVisible({ timeout: 20_000 });
  await search.fill(nameB);
  await pageA.getByRole('button', { name: /^Search$/i }).first().click().catch(() => {});
  let found = false;
  for (let i = 0; i < 10; i++) {
    await pageA.waitForTimeout(5000);
    if (new RegExp(nameB, 'i').test(await bodyOf(pageA))) { found = true; break; }
  }
  expect(found, `the member (${nameB}) never appeared in search — discovery, not messaging`).toBe(true);
  await pageA.getByText(new RegExp(nameB, 'i')).first().click().catch(() => {});
  await pageA.waitForTimeout(1000);

  const bodyText = `notice from ${orgName} at ${stamp}`;
  const composer = pageA.getByPlaceholder(/Write your message/i).first();
  await composer.fill(bodyText);
  const sendBtn = pageA.locator('button.chat-send-btn, button[aria-label="Send message"]').first();
  await expect(sendBtn).toBeVisible({ timeout: 15_000 });
  await sendBtn.click();
  await pageA.waitForTimeout(6000);

  // ── The org has no wire yet, so its agent refuses — and the steward can fix it ────────────────
  const approve = pageA.getByRole('button', { name: /^Approve$/ }).first();
  const needsApproval = await approve.count().then((c) => c > 0);
  console.log('approval affordance shown:', needsApproval, '|', (await bodyOf(pageA)).slice(0, 240));
  await shot(pageA, 'org-needs-approval');
  expect(needsApproval, 'the org has no wire, but no approval was offered — it refused for another reason').toBe(true);

  await approve.click();
  // The steward's credential signs, the ORG's account validates. Two delegations land, both with the
  // org as delegator, both re-verified at the agent before custody.
  for (let i = 0; i < 24; i++) {
    await pageA.waitForTimeout(5000);
    if ((await approve.count()) === 0) break;
  }
  await shot(pageA, 'org-approved');
  expect(await approve.count(), 'approval never completed — the org wire was rejected at the agent').toBe(0);

  if (await composer.count()) {
    await composer.fill(bodyText);
    await sendBtn.click().catch(() => {});
  }
  let sent = false;
  for (let i = 0; i < 12; i++) {
    await pageA.waitForTimeout(5000);
    if (new RegExp(bodyText.slice(0, 20), 'i').test(await bodyOf(pageA))) { sent = true; break; }
  }
  await shot(pageA, 'org-sent');
  expect(sent, "the org's own copy never appeared — the send was rejected after approval").toBe(true);

  // ── The member receives it FROM THE ORG ───────────────────────────────────────────────────────
  await pageB.goto(`${B.origin}/messages`);
  let received = false;
  for (let i = 0; i < 16; i++) {
    await pageB.waitForTimeout(5000);
    if (new RegExp(bodyText.slice(0, 20), 'i').test(await bodyOf(pageB))) { received = true; break; }
    await pageB.reload().catch(() => {});
  }
  await shot(pageB, 'member-inbox');
  const memberBody = await bodyOf(pageB);
  console.log('member received:', received, '|', memberBody.slice(0, 300));
  expect(received, "the member never received it — the org's A2A delivery did not land").toBe(true);

  // AUTHORSHIP IS THE ORG, NOT THE STEWARD. The receiving skill pins `envelope.from` to the transport
  // grant's delegator, so this is the assertion that the two identities stayed separate all the way
  // through: the steward drove it, the organization sent it.
  expect(memberBody, "the message is attributed to the steward, not the organization").not.toContain(nameA);
});
