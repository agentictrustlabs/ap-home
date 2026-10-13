/**
 * THE INVITATION, END TO END, THROUGH THE ASK (spec 421) — two people, two browsers, no buttons but the Ask's own.
 *
 *   1. alice (Missio Nexus's steward) asks her agent to invite nathan → grants the invitation (her signature)
 *   2. nathan asks his agent what he's been invited to → accepts it by asking → his Home runs the Join ceremony
 *   3. nathan opens the organization's discussion — he sees its topics, not "Request to join"
 *   4. alice asks who belongs to Missio Nexus → nathan is on the roster
 *
 * Asserted on what each PERSON sees. Runs against the live faithnet Home by default, or a preview (SSO_BASE_URL).
 * It changes the estate (nathan becomes a member of Missio Nexus); INVITEE / ORG_NAME / ORG_SA pick another pair.
 *
 *   SSO_BASE_URL=https://<preview>.vercel.app npx playwright test invite-accept-via-ask --config tests/e2e-sso/playwright.config.ts
 */
import { test, expect, type Page, type APIRequestContext, type Browser } from '@playwright/test';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
const INVITEE = process.env.INVITEE ?? 'nathan';
const ORG_NAME = process.env.ORG_NAME ?? 'missio nexus';
const ORG_SA = (process.env.ORG_SA ?? '0x3b99f2b452766de5df0dbcdfc676f27257151333').toLowerCase();
const shot = (p: Page, n: string) => p.screenshot({ path: `artifacts/invite-accept-${n}.png`, fullPage: true }).catch(() => undefined);

/** A demo persona's Home, in its own browser context. */
async function asPersona(browser: Browser, request: APIRequestContext, handle: string): Promise<Page> {
  // Sign-in is idempotent, so a transient network failure (DNS EAI_AGAIN, a slow first response) is retried — bounded.
  let r: Awaited<ReturnType<APIRequestContext['post']>> | null = null;
  for (let attempt = 1; attempt <= 3 && !r?.ok(); attempt++) {
    r = await request.post(`${HOME}/connect/demo-signin`, { data: { handle, client_id: 'demo-jp' }, timeout: 60_000 }).catch((e) => { console.log(`[${handle}] demo-signin attempt ${attempt}: ${String(e).slice(0, 120)}`); return null; });
    if (!r?.ok()) await new Promise((z) => setTimeout(z, 5_000));
  }
  expect(r?.ok(), `demo-signin ${handle}`).toBeTruthy();
  const { homeSession } = (await r!.json()) as { homeSession: string };
  const page = await (await browser.newContext()).newPage();
  page.on('response', async (res) => { if ((res.url().includes('/a2a/') || res.url().includes('/connect/')) && res.status() >= 500) console.log(`[${handle} ${res.status()}] ${res.url().slice(0, 120)} ${(await res.text().catch(() => '')).slice(0, 160)}`); });
  await page.goto(`${HOME}/#session=${homeSession}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('ask-toggle')).toBeVisible({ timeout: 60_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  return page;
}

/** START FROM "NOT A MEMBER": the invitee leaves (their own session) and the steward removes them — the org's roster, the
 *  member-access grant and the invitee's own record all cleared, so the flow is exercised from the beginning every run. */
async function resetMembership(request: APIRequestContext): Promise<void> {
  const token = async (h: string) => ((await (await request.post(`${HOME}/connect/demo-signin`, { data: { handle: h, client_id: 'demo-jp' }, timeout: 60_000 })).json()) as { homeSession: string; agent: string });
  const inv = await token(INVITEE), st = await token('alice');
  const leave = await request.post(`${HOME}/connect/directory`, { headers: { authorization: `Bearer ${inv.homeSession}` }, data: { action: 'revoke', communityId: ORG_SA } });
  const remove = await request.post(`${HOME}/connect/org-member-remove`, { headers: { authorization: `Bearer ${st.homeSession}` }, data: { org: ORG_SA, member: inv.agent.toLowerCase() } });
  console.log(`[reset] ${INVITEE} leave ${leave.status()} · steward remove ${remove.status()}`);
}

/** The bell's items of a kind, after opening it (opening refreshes). */
async function bellItems(page: Page, kind: string): Promise<string[]> {
  const bell = page.getByTestId('alert-bell');
  if (!(await page.getByTestId('alert-list').isVisible().catch(() => false))) await bell.click();
  await page.waitForTimeout(3_000);
  const rows = page.locator(`[data-testid="alert-item"][data-kind="${kind}"]`);
  const out = await rows.allTextContents().catch(() => [] as string[]);
  await bell.click().catch(() => undefined); // close
  return out;
}

/** The surface's own status lines are not the agent answering. */
const SURFACE_SAID = /^(authority granted|the invitation is stored|.* is in your agents now|working|joining|signing)/i;
const lastAgentSaid = async (page: Page) => ((await page.getByTestId('ask-flyout').locator('.ask-msg.agent:not([data-testid])').last().textContent().catch(() => '')) ?? '').trim();

/** Ask, and return which card came back. */
async function ask(page: Page, message: string, timeout = 180_000): Promise<'authority' | 'prompt' | 'answer' | 'none'> {
  const flyout = page.getByTestId('ask-flyout');
  if (!(await flyout.isVisible().catch(() => false))) await page.getByTestId('ask-toggle').click();
  await expect(flyout).toBeVisible();
  const before = await lastAgentSaid(page);
  await page.getByTestId('ask-input').fill(message);
  await page.getByTestId('ask-input').press('Enter');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.getByTestId('ask-authority').isVisible().catch(() => false)) return 'authority';
    if (await page.getByTestId('ask-prompt').isVisible().catch(() => false)) return 'prompt';
    const said = await lastAgentSaid(page);
    if (said && said !== before && said !== '…' && !said.includes(message) && !SURFACE_SAID.test(said) && (await page.getByTestId('ask-input').isEnabled().catch(() => false))) return 'answer';
    await page.waitForTimeout(1_500);
  }
  return 'none';
}

/** Wait for the agent to say something new that matches. */
async function waitForAgent(page: Page, pattern: RegExp, timeout = 240_000): Promise<string> {
  const deadline = Date.now() + timeout;
  let said = '';
  while (Date.now() < deadline) {
    said = await lastAgentSaid(page);
    // The surface's own lines ("Authority granted: invite members…") are not the agent's answer — matching them is how
    // the first run declared the invitation sent while alice's run still said "Working…".
    const settled = await page.getByTestId('ask-input').isEnabled().catch(() => false);
    if (settled && !SURFACE_SAID.test(said) && pattern.test(said)) return said;
    if (await page.getByTestId('ask-prompt').isVisible().catch(() => false)) return `PROMPT: ${await page.getByTestId('ask-prompt').innerText().catch(() => '')}`;
    await page.waitForTimeout(2_000);
  }
  return said;
}

test('alice invites nathan by asking; nathan accepts by asking, sees the discussion; alice sees him on the roster', async ({ browser, request }) => {
  test.setTimeout(900_000);

  await resetMembership(request);

  // ── 1. alice invites, and grants it ──────────────────────────────────────────────────────────────────────────────
  const alice = await asPersona(browser, request, 'alice');
  const first = await ask(alice, `invite ${INVITEE} to ${ORG_NAME}`);
  await shot(alice, '1-alice-invite');
  expect(first, 'the invitation asks for her authority (an organization invites under its steward\'s signature)').toBe('authority');
  await expect(alice.getByTestId('ask-authority')).toContainText(/invite/i);
  await expect(alice.getByTestId('ask-authority'), 'no false "not from what you said" — she named both').not.toContainText(/not from what you said/i);
  await alice.getByTestId('ask-grant').click();
  const invited = await waitForAgent(alice, /invit|sent|nothing was changed|did not go through|already|resume_integrity/i);
  await shot(alice, '2-alice-invited');
  expect(invited, `the invitation went out (got: ${invited})`).not.toMatch(/did not go through|resume_integrity|nothing was changed/i);

  // ── 2. nathan sees it and accepts it — by asking ─────────────────────────────────────────────────────────────────
  const nathan = await asPersona(browser, request, INVITEE);
  expect(await ask(nathan, 'what invitations do I have?')).toBe('answer');
  await expect.poll(async () => lastAgentSaid(nathan), { message: 'the invitation reached his inbox', timeout: 60_000 }).toMatch(/missio/i);
  await shot(nathan, '3-nathan-invitations');
  // THE BELL (B6a): the invitation is waiting on him — on every page, before he has asked anything.
  await expect.poll(async () => (await bellItems(nathan, 'invitation')).join(' | '), { message: 'his bell lists the invitation', timeout: 150_000, intervals: [5_000, 15_000, 30_000] }).toMatch(/missio/i);
  await shot(nathan, '3b-nathan-bell');
  // …and the same list, asked (B6a's Ask half, `person.waiting.list`).
  expect(await ask(nathan, "what's waiting on me?")).toBe('answer');
  await expect.poll(async () => lastAgentSaid(nathan), { message: 'his agent says the invitation is waiting on him', timeout: 60_000 }).toMatch(/missio/i);

  const accepting = await ask(nathan, `accept the invitation to ${ORG_NAME}`);
  await shot(nathan, '4-nathan-accept-card');
  expect(accepting, 'accepting parks for the Join ceremony at his Home').toBe('prompt');
  const join = nathan.getByTestId('ask-answer');
  await expect(join, 'the card says what the click does').toHaveText(/join/i);
  await join.click();
  // The ceremony runs ON the card ("Joining…": listing, membership, countersignature — signed with his credential); the card
  // stays up until it is done and the step resumes. Wait for it to clear before reading what his agent says.
  // …or the ceremony fails, which the card says in an alert — read it, so a failure names its cause.
  const ceremonyEnd = Date.now() + 300_000;
  let ceremonyError = '';
  while (Date.now() < ceremonyEnd) {
    if (!(await nathan.getByTestId('ask-prompt').isVisible().catch(() => false))) break;
    ceremonyError = ((await nathan.locator('.ask-err[role="alert"]').first().textContent().catch(() => '')) ?? '').trim();
    if (ceremonyError) break;
    await nathan.waitForTimeout(2_000);
  }
  await shot(nathan, '5-nathan-after-join');
  expect(ceremonyError, 'the join ceremony ran without an error').toBe('');
  await expect(nathan.getByTestId('ask-prompt'), 'the join ceremony finishes and the step resumes').toBeHidden({ timeout: 10_000 });
  const joined = await waitForAgent(nathan, /joined|already belong|not recorded|nothing changed/i);
  await shot(nathan, '5-nathan-joined');
  expect(joined, `his records say he joined (got: ${joined})`).toMatch(/joined|already belong/i);

  await expect.poll(async () => (await bellItems(nathan, 'invitation')).join(' | '), { message: 'the bell clears once he has joined', timeout: 150_000, intervals: [5_000, 15_000, 30_000] }).not.toMatch(/missio/i);

  // ── 3. nathan views the discussion ───────────────────────────────────────────────────────────────────────────────
  await nathan.goto(`${HOME}/org/${ORG_SA}/discussions`, { waitUntil: 'domcontentloaded' });
  await nathan.waitForLoadState('networkidle').catch(() => undefined);
  await expect.poll(async () => (await nathan.locator('body').innerText().catch(() => '')), { message: 'a member sees the topics, not the request-to-join card', timeout: 90_000 })
    .not.toMatch(/Request to join this organization/i);
  await shot(nathan, '6-nathan-discussion');

  // ── 4. alice sees him on the roster — by asking ──────────────────────────────────────────────────────────────────
  await alice.reload({ waitUntil: 'domcontentloaded' });
  await expect(alice.getByTestId('ask-toggle')).toBeVisible({ timeout: 60_000 });
  expect(await ask(alice, `who belongs to ${ORG_NAME}?`)).toBe('answer');
  await shot(alice, '7-alice-roster');
  await expect.poll(async () => lastAgentSaid(alice), { message: `${INVITEE} is on the roster`, timeout: 60_000 }).toMatch(new RegExp(INVITEE, 'i'));
});
