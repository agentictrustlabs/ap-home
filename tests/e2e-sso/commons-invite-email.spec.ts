/**
 * The full email-invite rail, starting where a person actually starts: Commons.
 *
 *   Alice (steward, demo persona) — Commons → Members → "Invite at your Home →" → Home invite
 *   panel → invite a new email. The email itself is BYPASSED: /connect/org-invite/email returns
 *   `joinUrl` to the steward's page, and the test intercepts that response — same link, no inbox.
 *
 *   The invitee — a brand-new person in a fresh browser context — opens the link, types how the
 *   org should know them, and accepts. They come out the other side signed in to Commons as a
 *   NAMELESS agent (no public handle — the typed name is org-local only), and must be able to:
 *     1. send a 1:1 message back to Alice (their join wire covers the inviter + org co-members),
 *     2. post to a discussion board under their org-local name.
 */
import { test, expect, type Page } from '@playwright/test';

const COMMONS = process.env.COMMONS_URL ?? 'https://commons-production.richardpedersen3.workers.dev/';
const ALICE_SA = '0xc35c8f17c9cbf58c20a4f4cd8bd702b8c91f532b';

const logNet = (page: Page, tag: string) => {
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${tag} console.error] ${m.text()}`); });
  page.on('response', async (r) => {
    const u = r.url();
    if ((u.includes('/api/') || u.includes('/connect/') || u.includes('/a2a/')) && r.status() >= 400) {
      console.log(`[${tag} net] ${r.request().method()} ${u} → ${r.status()} ${(await r.text().catch(() => '')).slice(0, 400)}`);
    }
  });
};

test('email invite: Alice invites from Commons; nameless invitee joins, DMs Alice, posts', async ({ page, browser }) => {
  test.setTimeout(600_000);
  logNet(page, 'alice');

  // ── Alice signs in to Commons through the demo-connect she would actually click. ──
  await page.goto(COMMONS);
  await page.getByRole('button', { name: /test identities/i }).click();
  await page.getByRole('button', { name: /connect as alice/i }).click();
  await page.waitForURL((u) => u.origin === new URL(COMMONS).origin && !u.hash.includes('session='), { timeout: 60_000 });
  await expect(page.getByText(/sign out/i)).toBeVisible({ timeout: 30_000 });

  // ── Members → the invite is ISSUED at the Home (it carries a grant the org signs). ──
  await page.getByRole('button', { name: /^members$/i }).click();
  const inviteLink = page.getByRole('link', { name: /invite at your home/i });
  await expect(inviteLink).toBeVisible({ timeout: 30_000 });
  const [homePage] = await Promise.all([page.context().waitForEvent('page'), inviteLink.click()]);
  logNet(homePage, 'home');

  // ── Home invite panel: invite a brand-new email; capture joinUrl from the response (email bypass). ──
  const email = `e2e-invitee-${Date.now()}@example.com`;
  const emailBox = homePage.getByPlaceholder('name@example.org');
  await expect(emailBox).toBeVisible({ timeout: 60_000 });
  await emailBox.fill(email);
  const inviteResp = homePage.waitForResponse(
    (r) => r.url().includes('/connect/org-invite/email') && r.request().method() === 'POST',
    { timeout: 180_000 },
  );
  await homePage.getByRole('button', { name: /send invite/i }).click();
  const inviteBody = (await (await inviteResp).json()) as { ok?: boolean; joinUrl?: string; error?: string };
  expect(inviteBody.ok, `invite create failed: ${inviteBody.error ?? '(no error body)'}`).toBeTruthy();
  expect(inviteBody.joinUrl, 'invite response must carry joinUrl').toBeTruthy();
  console.log(`[test] invite issued for ${email}`);

  // ── The invitee: a fresh browser context — no cookies, no home, nobody. ──
  const inviteeCtx = await browser.newContext();
  const invitee = await inviteeCtx.newPage();
  logNet(invitee, 'invitee');
  const orgLocalName = `Guest ${String(Date.now()).slice(-6)}`;

  await invitee.goto(inviteBody.joinUrl!);
  await expect(invitee.getByRole('heading', { name: /you're invited/i })).toBeVisible({ timeout: 30_000 });
  await invitee.getByPlaceholder(/display name/i).fill(orgLocalName);
  await invitee.getByRole('button', { name: /accept & join/i }).click();

  // Accept bootstraps a KMS home, publishes the org-local listing, provisions the join wire, then
  // routes into Commons — which hops back to Home ONCE for the site-login consent (the person
  // explicitly gives Commons permission; that click is the ceremony, so the test performs it).
  const consent = invitee.getByRole('button', { name: /give commons permission/i });
  const signedIn = invitee.getByText(/sign out/i);
  await expect(consent.or(signedIn)).toBeVisible({ timeout: 300_000 });
  if (await consent.isVisible().catch(() => false)) {
    await consent.click();
  }
  await invitee.waitForURL((u) => u.origin === new URL(COMMONS).origin && !u.search.includes('code='), { timeout: 120_000 });
  await expect(signedIn).toBeVisible({ timeout: 60_000 });
  console.log('[test] invitee is signed in to Commons');

  // ── NAMELESS, but named in the org: the join must not have claimed a public handle. ──
  const meResp = await invitee.request.get(new URL('/api/me', COMMONS).toString()).then((r) => r.json()) as { me?: { agentName?: string | null; person?: string } | null };
  expect(meResp.me, 'invitee must have a Commons session').toBeTruthy();
  expect(meResp.me!.agentName ?? null, 'invitee must hold NO public agent name').toBeNull();
  const inviteeSA = (meResp.me!.person ?? '').toLowerCase();
  expect(inviteeSA).toMatch(/^0x[0-9a-f]{40}$/);
  console.log(`[test] invitee ${inviteeSA} is nameless, known as "${orgLocalName}" in the org`);

  // ── 1:1 back to Alice — covered by the join wire (inviter + org co-members), no extra ceremony. ──
  await invitee.getByRole('button', { name: /^messages$/i }).click();
  await expect(invitee.getByRole('heading', { name: /send a message/i })).toBeVisible({ timeout: 15_000 });
  await invitee.getByPlaceholder(/public agent name/i).fill(ALICE_SA);
  await invitee.getByPlaceholder(/subject/i).fill('Thanks for the invite');
  await invitee.getByPlaceholder('Message…').fill(`Hello Alice — from your new invitee (${orgLocalName})`);
  await invitee.getByRole('button', { name: /^send$/i }).click();
  await expect(invitee.getByText(/delivered ·/i)).toBeVisible({ timeout: 90_000 });
  console.log('[test] invitee → Alice delivered');

  // ── The ORG SCOPE CLASS, live: a co-member the invitee NEVER individually approved. Their join
  // wire holds exactly two entries — Alice (the inviter) and the org SA. Reaching any other current
  // member is covered only by the gate resolving the org class against the live roster; if this
  // send prompts for approval, the class is broken. ──
  const coMember = 'rich-global.impact';
  await invitee.getByPlaceholder(/public agent name/i).fill(coMember);
  await invitee.getByPlaceholder(/subject/i).fill('Hello from a co-member');
  await invitee.getByPlaceholder('Message…').fill(`We share a community — from ${orgLocalName}, never individually approved.`);
  // Judge the SEND ITSELF, not the banner — the first send's "delivered ·" is still on screen and
  // would satisfy a UI assertion before this send even resolves.
  const coResp = invitee.waitForResponse(
    (r) => r.url().includes('/api/messaging/send') && r.request().method() === 'POST',
    { timeout: 90_000 },
  );
  await invitee.getByRole('button', { name: /^send$/i }).click();
  const coBody = (await (await coResp).json()) as { messageId?: string; error?: string; code?: string };
  expect(coBody.messageId, `org-scope class must cover a co-member without a ceremony — got: ${coBody.error ?? coBody.code ?? JSON.stringify(coBody)}`).toBeTruthy();
  console.log(`[test] invitee → ${coMember} delivered via the org scope class (${coBody.messageId})`);

  // ── Discussion board, as the org-local name set during onboarding. ──
  await invitee.getByRole('button', { name: /^discussion$/i }).click();
  await expect(invitee.getByRole('heading', { name: /topics in/i })).toBeVisible({ timeout: 30_000 });
  // The listing they signed at accept IS their community name — the board must already know it.
  await expect(invitee.getByText(new RegExp(`posting as\\s+${orgLocalName}`, 'i'))).toBeVisible({ timeout: 30_000 });
  const topicTitle = `Welcome thread ${String(Date.now()).slice(-6)}`;
  await invitee.getByPlaceholder('Open a topic…').fill(topicTitle);
  await invitee.getByRole('button', { name: /^open$/i }).click();
  const say = invitee.getByPlaceholder('Say something…');
  await expect(say).toBeVisible({ timeout: 60_000 });
  const post = `First post from ${orgLocalName} — the vault holds this, not the app.`;
  await say.fill(post);
  await invitee.getByRole('button', { name: /^post$/i }).click();
  await expect(invitee.getByText(post)).toBeVisible({ timeout: 60_000 });
  console.log('[test] invitee posted to the discussion board');

  await inviteeCtx.close();
});
