/**
 * Slack-style DMs + the scoped To: picker (spec 313 §2.1, W6/W6b).
 *
 * Alice (demo persona) opens Messages → New message, picks a WORKSPACE (a team she stewards) in the
 * left pane, sees its members on the right — including members who joined by invite and have NO
 * naming-service name — picks one, sends, and the DM lands in the rail bucketed by that person with
 * a "You: …" preview. If the send needs the one-prompt wire ceremony, the test walks it.
 *
 * Runs against whatever SSO_BASE_URL points at (default: the local dev Home). Uses only what exists:
 *   DM_SCOPE   — the team/org label to open (default: russian-team.impact)
 *   DM_MEMBER  — optional: a substring of the member row to pick (default: the first row)
 */
import { test, expect, type Page } from '@playwright/test';

const HOME = process.env.SSO_BASE_URL ?? 'http://localhost:5373';
const SCOPE = process.env.DM_SCOPE ?? 'russian-team.impact';
const MEMBER = process.env.DM_MEMBER ?? '';

async function signInAsAlice(page: Page, request: Parameters<Parameters<typeof test>[1]>[0]['request']) {
  const res = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'alice', client_id: 'demo-jp' } });
  expect(res.ok(), 'demo-signin must mint a session for alice').toBe(true);
  const body = (await res.json()) as { homeSession?: string; agent?: string; agent_name?: string };
  expect(body.homeSession, 'homeSession token').toBeTruthy();
  await page.goto(`${HOME}/you#session=${body.homeSession}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('link', { name: /^Messages$/ }).first()).toBeVisible({ timeout: 60_000 });
  return { agent: (body.agent ?? '').toLowerCase(), name: body.agent_name ?? 'alice' };
}

test('alice DMs a workspace member picked from the scoped To: picker', async ({ page, request }) => {
  test.setTimeout(300_000);
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 300)}`); });
  page.on('response', async (r) => {
    const u = r.url();
    if ((u.includes('/a2a/interactions/') || u.includes('/connect/directory') || u.includes('received-delegations')) && (r.status() >= 400)) {
      console.log(`[net] ${r.request().method()} ${u} → ${r.status()} ${(await r.text().catch(() => '')).slice(0, 300)}`);
    }
  });

  await signInAsAlice(page, request);
  await page.goto(`${HOME}/messages`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.chat-rail-head__title')).toHaveText('Direct messages', { timeout: 60_000 });

  // ── New message → the picker: search on top, scopes left, people right. ──
  await page.locator('.chat-rail-compose').click();
  const picker = page.getByTestId('dm-picker');
  await expect(picker).toBeVisible({ timeout: 15_000 });
  await expect(picker.getByText('Organizations')).toBeVisible();
  await expect(picker.getByText('Workspaces')).toBeVisible();
  console.log('✓ picker shows Names / Organizations / Workspaces');

  // ── Pick the scope by its label (a team lives under Workspaces). ──
  const scopeBtn = picker.locator('.chat-picker__scope', { hasText: SCOPE }).first();
  await expect(scopeBtn, `scope "${SCOPE}" is listed`).toBeVisible({ timeout: 30_000 });
  await scopeBtn.click();
  // The section title carries the count once the roster has LOADED — never read rows before that.
  const sectionTitle = SCOPE === 'Names' ? 'People with a name ·' : `Members of ${SCOPE} ·`;
  await expect(picker.locator('.chat-picker__section', { hasText: sectionTitle })).toBeVisible({ timeout: 30_000 });

  // ── Members appear — including invite-only members with no naming-service name. ──
  const rows = picker.locator('[data-testid^="dm-recipient-"]');
  await expect(rows.first(), `${SCOPE} lists at least one member`).toBeVisible({ timeout: 30_000 });
  const count = await rows.count();
  const labels = await rows.allInnerTexts();
  console.log(`✓ ${SCOPE}: ${count} member(s): ${labels.map((l) => l.replace(/\s+/g, ' ').trim()).join(' | ')}`);
  await page.screenshot({ path: 'artifacts/dm-picker.png', fullPage: false });

  const target = MEMBER ? rows.filter({ hasText: MEMBER }).first() : rows.first();
  const targetId = await target.getAttribute('data-testid');
  const targetAddr = (targetId ?? '').replace('dm-recipient-', '');
  const targetTitle = (await target.locator('.chat-compose-result__name').innerText()).trim();
  expect(targetAddr).toMatch(/^0x[0-9a-f]{40}$/);

  // Filter-as-you-type narrows to the target.
  await page.getByTestId('dm-compose-to').fill(targetTitle.slice(0, 4));
  await expect(rows.first()).toBeVisible();
  await target.click();

  // Slack rule: picking someone you ALREADY message opens that DM; a new counterparty stays in compose
  // with a To: chip until the first send. Both end at a composer.
  const chip = page.locator('.chat-compose-to__chip');
  const threadTitle = page.locator('.chat-thread-header__title');
  await expect(chip.or(threadTitle).first()).toBeVisible({ timeout: 30_000 });
  const existing = !(await chip.isVisible().catch(() => false));
  console.log(`✓ picked ${targetTitle} (${targetAddr}) — ${existing ? 'existing DM opened' : 'new DM compose'}`);

  // ── Send. The composer's Enter sends. ──
  const stamp = `Playwright DM ${new Date().toISOString()}`;
  const composer = page.locator('.chat-composer textarea');
  await composer.fill(stamp);
  await composer.press('Enter');

  // Either the thread shows the message, or the wire ceremony is asked for first.
  const sent = page.locator('.chat-thread-body', { hasText: stamp });
  const approve = page.getByRole('button', { name: /^Approve/ });
  const errorLine = page.locator('p[style*="danger"]').first();
  await expect(sent.or(approve).or(errorLine).first()).toBeVisible({ timeout: 90_000 });

  if (await approve.isVisible().catch(() => false)) {
    // ONE ceremony: Approve signs the wire AND finishes the refused send — no reload, no retyping.
    console.log('[test] send needs the one-prompt wire approval — signing');
    await approve.click();
    // The button relabels to "Signing…" while it works; the BANNER leaving is the real signal.
    const banner = page.locator('.chat-attention', { hasText: /approved messaging|Approve this agent/ });
    await expect(banner).toBeHidden({ timeout: 120_000 });
    await expect(sent.or(errorLine).first()).toBeVisible({ timeout: 90_000 });
    console.log('✓ approval finished the pending send by itself');
  }
  if (!(await sent.isVisible().catch(() => false)) && (await errorLine.isVisible().catch(() => false))) {
    throw new Error(`send failed: ${(await errorLine.innerText()).slice(0, 300)}`);
  }
  await expect(sent).toBeVisible({ timeout: 60_000 });

  // The thread header names the counterparty (naming-service name when they have one).
  const railTitle = (await threadTitle.innerText()).trim();
  const railItem = page.locator('.chat-rail-item', { hasText: railTitle }).first();

  // ── The rail is bucketed by WHO: one row for this person, last message previewed as "You: …". ──
  await expect(railItem).toBeVisible({ timeout: 60_000 });
  await expect(railItem.locator('.chat-rail-item__preview')).toContainText(/You: Playwright DM/, { timeout: 60_000 });
  console.log(`✓ DM with ${railTitle} in the rail with "You:" preview; message in thread`);

  // ── No duplicate buckets for the same person. ──
  const dupes = await page.locator('.chat-rail-item', { hasText: railTitle }).count();
  expect(dupes, 'exactly one rail row per counterparty').toBe(1);
  await page.screenshot({ path: 'artifacts/dm-scoped-picker.png', fullPage: false });
});
