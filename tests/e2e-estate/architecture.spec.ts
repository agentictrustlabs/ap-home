import { expect, test, type Page } from '@playwright/test';

const POSTS = ['sign-in', 'harness-needs-substrate', 'scripture-ask', 'agent-harness'];
const FLOWS = ['sign-in', 'scripture-ask', 'agent-harness'];

/** Fails on any script error, failed asset, or console error the page raises. */
function watch(page: Page): string[] {
  const bad: string[] = [];
  page.on('pageerror', (e) => bad.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
  return bad;
}
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('the index lists every post, each opens, and no menu for a visitor', async ({ page }) => {
  const bad = watch(page);
  await page.goto('/architecture');
  for (const slug of POSTS) await expect(page.locator(`a[href="/architecture/${slug}"]`).first()).toBeVisible();
  expect(await noSideScroll(page)).toBeLessThanOrEqual(0);
  expect(bad).toEqual([]);
});

for (const slug of POSTS) {
  test(`${slug}: renders whole, picture loaded, described, no errors, no sideways scroll`, async ({ page }) => {
    const bad = watch(page);
    await page.goto(`/architecture/${slug}`);
    await expect(page.locator('h1')).toBeVisible();
    const pics = page.locator('figure.picture img');
    await expect(pics.first()).toBeVisible();
    for (const img of await pics.all()) {
      expect(await img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), await img.getAttribute('src')).toBe(true);
      expect((await img.getAttribute('alt'))?.length ?? 0).toBeGreaterThan(100);
    }
    expect(await noSideScroll(page)).toBeLessThanOrEqual(0);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /\.png$/);
    const og = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect((await page.request.get(og!)).status()).toBe(200);
    expect(bad).toEqual([]);
  });
}

for (const slug of FLOWS) {
  test(`${slug}: every step opens its flyout, and closes`, async ({ page }) => {
    await page.goto(`/architecture/${slug}`);
    const ids = await page.locator('aside.fly').evaluateAll((a) => a.map((x) => x.id));
    expect(ids.length).toBeGreaterThan(3);
    for (const id of ids) {
      const link = page.locator(`ol a[href="#${id}"], .steps a[href="#${id}"], a[href="#${id}"]:not(svg a)`).first();
      await link.click();
      await expect(page).toHaveURL(new RegExp(`#${id}$`));
      const panel = page.locator(`#${id}`);
      await expect(panel).toBeVisible();
      await expect(panel.locator('h3').first()).toBeInViewport({ ratio: 0.1 });
      await page.goto(`/architecture/${slug}#closed`);
      await expect(panel).toBeHidden();
    }
  });
}

test('sign-in: the next design is there, reachable from the callout, and every in-page link lands', async ({ page }) => {
  await page.goto('/architecture/sign-in');
  await page.locator('.callout a[href="#next-design"]').click();
  await expect(page.locator('#next-design')).toBeInViewport();
  await expect(page.locator('#next-design')).toHaveText('The next design: the Home remembers an Allow');
  for (const h of ['Who is asking: a cookie script cannot read', 'When the sheet is skipped', 'Silent sign-in', 'What a second review changed', 'Still open']) {
    await expect(page.getByRole('heading', { name: h })).toBeVisible();
  }
  const hrefs = await page.locator('.post a[href^="#"]').evaluateAll((a) => [...new Set(a.map((x) => x.getAttribute('href')!))]);
  for (const h of hrefs) if (h !== '#closed') expect(await page.locator(h).count(), h).toBe(1);
  await expect(page.locator('body')).not.toContainText(/Reformation Study|\bRSB\b/);
  await expect(page.locator('body')).not.toContainText('kept for up to thirty days');
});

test('sign-in: the picture says the arc is the next design, and the tiles link to their steps', async ({ page }) => {
  const svg = await (await page.request.get('/architecture/sign-in-flow.svg')).text();
  expect(svg).toContain('THE NEXT DESIGN, LIVE IN SHADOW');
  expect(svg).not.toContain('PROPOSED');
  expect(svg).not.toContain('does not');
  await page.goto('/architecture/sign-in');
  const picLinks = await page.locator('a[href^="#step-"]').count();
  expect(picLinks).toBeGreaterThanOrEqual(10);
});

test('every link off a post answers', async ({ page }) => {
  for (const slug of POSTS) {
    await page.goto(`/architecture/${slug}`);
    const hrefs = await page.locator('main a[href^="/"], .post a[href^="/"]').evaluateAll((a) => [...new Set(a.map((x) => x.getAttribute('href')!))]);
    for (const h of hrefs) expect((await page.request.get(h)).status(), `${slug} → ${h}`).toBe(200);
  }
});

test('a visitor gets the cover, and the steward pages stay back', async ({ page }) => {
  const bad = watch(page);
  await page.goto('/');
  await expect(page.locator('.cover')).toBeVisible();
  await expect(page.locator('.cover button[data-signin]')).toBeVisible();
  await expect(page.locator('main#main')).toBeHidden();
  await expect(page.locator('nav a[data-auth]').first()).toBeHidden();
  await expect(page.locator('nav a[href="/architecture"]')).toBeVisible();
  expect(bad.filter((b) => !b.includes('/api/heartbeat'))).toEqual([]);
});

test('an unknown post is a 404, not an empty page', async ({ page }) => {
  expect((await page.goto('/architecture/no-such-post'))?.status()).toBe(404);
  await expect(page.locator('h1')).toHaveText('That page is not here');
  await expect(page.locator('main a[href="/architecture"]')).toBeVisible();
});

test('the manage door refuses another origin', async ({ request }) => {
  const r = await request.post('/api/manage/runs', { headers: { origin: 'https://evil.example' }, data: {} });
  expect(r.status()).toBe(403);
});
