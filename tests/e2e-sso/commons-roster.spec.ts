/**
 * The community roster and the recipient picker, against production.
 *
 * Members: every row shows the org-local name AND either the member's live naming-service name
 * (a badge) or an explicit "no public name" — two different facts, never one falling into the
 * other. Messages: the recipient input suggests the community's members by whichever name will
 * actually resolve (public agent name, else org-local name).
 */
import { test, expect } from '@playwright/test';

const COMMONS = process.env.COMMONS_URL ?? 'https://commons-production.richardpedersen3.workers.dev/';

test('Members shows public names; compose suggests org members', async ({ page }) => {
  test.setTimeout(240_000);

  page.on('response', async (r) => {
    if (r.url().includes('/api/members')) {
      const body = await r.text().catch(() => '(unreadable)');
      console.log(`[net] GET ${r.url()} → ${r.status()} ${body.slice(0, 800)}`);
    }
  });

  // ── Connect as Alice through Commons' own demo-connect. ──
  await page.goto(COMMONS);
  const toggle = page.getByRole('button', { name: /test identities/i });
  await expect(toggle, 'Commons must offer test identities').toBeVisible({ timeout: 20_000 });
  await toggle.click();
  const connect = page.getByRole('button', { name: /connect as alice/i });
  await expect(connect).toBeVisible({ timeout: 15_000 });
  await connect.click();
  await page.waitForURL((u) => u.origin === new URL(COMMONS).origin && !u.hash.includes('session='), { timeout: 60_000 });
  await expect(page.getByText(/sign out/i)).toBeVisible({ timeout: 30_000 });

  // ── Members: each row carries a public-name badge OR says so plainly. ──
  await page.getByRole('button', { name: 'members' }).click();
  await expect(page.getByRole('heading', { name: /in this community/i })).toBeVisible({ timeout: 15_000 });
  const rows = page.locator('.item', { has: page.locator('.addr') });
  await expect(rows.first(), 'the roster must not be empty for a member').toBeVisible({ timeout: 30_000 });
  const rowCount = await rows.count();
  let badged = 0;
  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const badge = row.locator('.badge');
    const nameless = row.getByText(/no public name/i);
    await expect(badge.or(nameless).first(), `row ${i} must state its public-name fact`).toBeVisible();
    if (await badge.isVisible().catch(() => false)) {
      badged++;
      await expect(badge).toHaveText(/\.\w+/); // a naming-service name has a dot
    }
  }
  console.log(`[test] roster: ${rowCount} members, ${badged} with a live public name`);

  // ── Messages: the recipient input offers the community's members as suggestions. ──
  await page.getByRole('button', { name: 'messages' }).click();
  await expect(page.getByRole('heading', { name: /send a message/i })).toBeVisible({ timeout: 15_000 });
  const input = page.getByPlaceholder(/public agent name/i);
  await expect(input).toHaveAttribute('list', 'commons-recipient-options');
  const options = page.locator('datalist#commons-recipient-options option');
  await expect
    .poll(async () => options.count(), { message: 'member suggestions must populate', timeout: 30_000 })
    .toBeGreaterThan(0);
  const values = await options.evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  console.log(`[test] recipient suggestions: ${values.join(', ')}`);
  expect(values.every((v) => v.trim().length > 0)).toBe(true);
});
