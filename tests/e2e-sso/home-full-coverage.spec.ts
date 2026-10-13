import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { CAST, onboardPersona } from './demo-user';
import { onboard } from './onboard';
import { estateDomain } from './estate';

// FULL SURFACE COVERAGE of the Home (`apps/home`) — every route in its own navigation.
//
// WHAT THIS IS FOR. The other specs each drive one journey deeply; between them they touch maybe a third
// of the app. A route that no journey visits can break and stay broken indefinitely, and the Home ships
// as one Vercel deploy, so a change anywhere reaches all of it at once. This walks the whole nav.
//
// THE ROUTE LIST IS TAKEN FROM `src/components/portal/nav.ts`, not invented. That matters: a hand-written
// list drifts the moment someone adds a page, and a coverage suite that silently stops covering a new
// route is worse than none — it reports the same green while covering less. `nav.coverage` below asserts
// the two agree, so adding a page to the app fails this test until the page is walked.
//
// WHAT "COVERED" MEANS, stated so nobody reads more into it: the route rendered real content for a
// signed-in member, logged no page error, and returned no 5xx. It does NOT mean the feature works. The
// deep specs prove features; this proves the surface exists and is reachable, which is the thing nothing
// else was checking.

interface Route { path: string; label: string; expect?: RegExp }

/** Person routes — the signed-in member's own surface (nav.ts: primary + settings groups). */
const PERSON_ROUTES: Route[] = [
  { path: '/', label: 'Home' },
  { path: '/messages', label: 'Messages' },
  { path: '/work', label: 'My Work' },
  { path: '/library', label: 'Library' },
  { path: '/organizations', label: 'Organizations' },
  { path: '/treasuries', label: 'Treasuries' },
  { path: '/alliances', label: 'Alliances' },
  { path: '/registry', label: 'Registry' },
  { path: '/naming', label: 'Naming' },
  { path: '/skills', label: 'Capabilities' },
  { path: '/trust-graph', label: 'Trust graph' },
  { path: '/network', label: 'Network' },
  { path: '/you', label: 'Profile' },
  { path: '/agent', label: 'Agent' },
  { path: '/metadata', label: 'Metadata' },
  { path: '/records', label: 'Records' },
  { path: '/visibility', label: 'Visibility' },
  { path: '/security', label: 'Security' },
  { path: '/apps', label: 'Connected' },
  { path: '/attestations', label: 'Attestations' },
  { path: '/activity', label: 'Activity' },
  { path: '/data-sources', label: 'Data sources' },
];

/** Org routes, walked as a steward. `<org>` is substituted with a real org SA. */
const ORG_ROUTES: Route[] = [
  { path: '/org/<org>/overview', label: 'Org overview' },
  { path: '/org/<org>/messages', label: 'Org messages' },
  { path: '/org/<org>/discussions', label: 'Org discussions' },
  { path: '/org/<org>/work', label: 'Org work' },
  { path: '/org/<org>/library', label: 'Org library' },
  { path: '/org/<org>/profile', label: 'Org profile' },
  { path: '/org/<org>/agent', label: 'Org agent' },
  { path: '/org/<org>/members', label: 'Org members' },
  { path: '/org/<org>/records', label: 'Org records' },
  { path: '/org/<org>/access', label: 'Org access' },
  { path: '/org/<org>/trust-graph', label: 'Org trust graph' },
  { path: '/org/<org>/treasury', label: 'Org treasury' },
];

interface Result { label: string; path: string; ok: boolean; detail: string }
const results: Result[] = [];

async function walk(page: Page, origin: string, r: Route): Promise<Result> {
  const errs: string[] = [];
  const fatal: string[] = [];
  const onErr = (e: Error): void => { errs.push(e.message.slice(0, 90)); };
  const onResp = (resp: { status(): number; url(): string }): void => {
    // 401/403 on a gated surface is CORRECT, not a failure — counting them would make every properly
    // secured page look broken. Only a 5xx says the server could not answer.
    if (resp.status() >= 500) fatal.push(`${resp.status()} ${new URL(resp.url()).pathname}`);
  };
  page.on('pageerror', onErr);
  page.on('response', onResp);
  try {
    const resp = await page.goto(`${origin}${r.path}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (!resp || resp.status() >= 400) return { ...r, ok: false, detail: `HTTP ${resp?.status() ?? 'none'}` };
    await page.waitForTimeout(4500); // let the client component mount and its first fetch settle
    const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    // The blank shell: 200, valid HTML, nothing rendered. Invisible to a status check, and the most
    // common way a route "exists" while being useless.
    if (body.length < 60) return { ...r, ok: false, detail: `${body.length} chars — blank shell?` };
    if (/application error|something went wrong|unhandled/i.test(body)) return { ...r, ok: false, detail: body.slice(0, 100) };
    if (errs.length) return { ...r, ok: false, detail: `pageerror: ${errs[0]}` };
    if (fatal.length) return { ...r, ok: false, detail: `5xx: ${fatal.slice(0, 2).join(', ')}` };
    if (r.expect && !r.expect.test(body)) return { ...r, ok: false, detail: `no match for ${r.expect}` };
    return { ...r, ok: true, detail: `${body.length} chars` };
  } catch (e) {
    return { ...r, ok: false, detail: e instanceof Error ? e.message.slice(0, 90) : String(e) };
  } finally {
    page.off('pageerror', onErr);
    page.off('response', onResp);
  }
}

test('every route in the Home’s navigation renders for a signed-in member', async ({ browser }) => {
  test.setTimeout(1_800_000);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // `COVERAGE_FRESH=1` onboards a THROWAWAY instead of the stable persona. It exists to test one
  // hypothesis: org-create succeeds in `work-requests.spec.ts`, which uses a fresh user, and does not
  // here, which uses `ada`. If the org surface walks under this flag and not without it, the difference
  // is the ACCOUNT, not the sequence — and that is a product finding, not a test one.
  const fresh = process.env.COVERAGE_FRESH === '1';
  const home = fresh
    ? { ...(await onboard(page, `cov${Date.now().toString(36).slice(-7)}`)), existing: false }
    : await onboardPersona(page, CAST.ada);
  console.log(`[coverage] persona=${fresh ? 'FRESH' : CAST.ada.name} home=${home.origin} existing=${home.existing}`);
  // The one hard gate. Every route below reads a signed-in session, so without a home they would all
  // fail for that single reason and the report would be noise wearing the shape of findings.
  expect(home.origin, 'ada never reached a home').toContain(estateDomain());

  for (const r of PERSON_ROUTES) {
    const res = await walk(page, home.origin, r);
    results.push(res);
    console.log(`${res.ok ? '✓' : '✗'} ${res.label.padEnd(16)} ${res.path.padEnd(16)} ${res.detail}`);
  }

  // ── Org surface, as a steward ─────────────────────────────────────────────────────────────────────
  // Walked with an org this cast already stewards. If there is none, the org routes are reported
  // UNCOVERED rather than skipped silently — "no org to walk" and "the org pages work" are different
  // facts, and only one of them is a pass.
  /**
   * Find an org this persona stewards.
   *
   * ORGS RENDER AS BUTTONS, not as `<a href="/org/0x…">`. My first version looked only for that anchor,
   * never matched, and reported "no org" while `ada` had FOUR — created by this very spec's fallback on
   * previous runs, each of which succeeded and then went unrecognised. I then misdiagnosed it twice
   * (returning-account behaviour, then the paymaster) before dumping the page and seeing them listed.
   *
   * The cheap evidence — printing what the page actually says — settled in ninety seconds what two
   * hypotheses and five ten-minute runs could not.
   */
  /**
   * Find an org this persona stewards — from the EXPLORER LINK, which is the only place the full address
   * appears on this page.
   *
   * Two wrong selectors before this one, and both were guesses. The org rows are not
   * `<a href="/org/0x…">`; and the button's accessible name is "Copy address 0x87d6…6fbe", not the bare
   * truncated address, so an anchored `/^0x…$/` could never match. Dumping the DOM showed both in one
   * pass — after five ten-minute runs spent inferring instead of looking.
   *
   * The explorer href carries the address UNTRUNCATED, which is what makes it the right source: the
   * button text is elided by design and can never yield the other 32 characters.
   */
  const findOrg = async (): Promise<string | null> => {
    await page.goto(`${home.origin}/organizations`);
    await page.waitForTimeout(6000);
    const hrefs = await page
      .locator('a[href*="basescan"]')
      .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''))
      .catch(() => [] as string[]);
    for (const h of hrefs) {
      const m = h.match(/0x[0-9a-fA-F]{40}/)?.[0];
      if (m) return m;
    }
    return null;
  };

  let orgSa = await findOrg();
  if (!orgSa) {
    // CREATE ONE RATHER THAN REPORT TWELVE UNCOVERED ROUTES. The first run found none — `ada` stewards
    // no organization — so a third of the app went unwalked and the spec correctly refused to call that
    // a pass. The cast is stable, so this happens ONCE: every later run finds the org this one made.
    console.log('[coverage] no org — creating one so the org surface can be walked');
    // DO NOT SWALLOW THIS. Two runs produced neither an org NOR an error, because the click was wrapped
    // in `.catch(() => {})` — so a missing button and a failed creation looked identical, and I guessed
    // at the cause twice. The page renders only ~436 chars, which is small enough that the control may
    // simply not be there for this persona. Now it reports what it actually saw.
    const createBtn = page.getByRole('button', { name: 'Create organization', exact: true }).first();
    if (!(await createBtn.count().catch(() => 0))) {
      const seen = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
      console.log(`[coverage] NO "Create organization" CONTROL on /organizations :: ${seen.slice(0, 220)}`);
    } else {
      await createBtn.click();
    }
    await page.waitForTimeout(1500);
    await page.locator('input:visible').first().fill(`cov${Date.now().toString(36).slice(-6)}`).catch(() => {});
    await page.getByRole('button', { name: /Create \+ name|^Create$/i }).first().click().catch(() => {});
    // POLL THE SAME PAGE. My first version called `findOrg()` in the retry loop, and `findOrg` navigates
    // to /organizations — so every retry tore down the in-flight creation and started the wait again.
    // The org never appeared, and I read that as "org-create is broken" rather than "I kept interrupting
    // it". `work-requests.spec.ts` gets this right by polling the body without navigating; copied.
    for (let i = 0; i < 20 && !orgSa; i++) {
      await page.waitForTimeout(5000);
      const b = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
      if (/went wrong|AA31|too low/i.test(b)) { console.log(`[coverage] org-create failed: ${b.slice(0, 160)}`); break; }
      const href = await page.locator('a[href*="/org/0x"]').first().getAttribute('href').catch(() => null);
      orgSa = href?.match(/0x[0-9a-fA-F]{40}/)?.[0] ?? null;
    }
    if (!orgSa) orgSa = await findOrg(); // one navigation AFTER the wait, in case the list needs a reload
  }
  console.log(`[coverage] org surface: ${orgSa ?? 'NO ORG — org routes uncovered this run'}`);

  if (orgSa) {
    for (const r of ORG_ROUTES) {
      const res = await walk(page, home.origin, { ...r, path: r.path.replace('<org>', orgSa) });
      results.push(res);
      console.log(`${res.ok ? '✓' : '✗'} ${res.label.padEnd(16)} ${res.path.padEnd(16)} ${res.detail}`);
    }
  } else {
    for (const r of ORG_ROUTES) results.push({ ...r, ok: false, detail: 'UNCOVERED — no org stewarded by this persona' });
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n── Home surface coverage ──\n${results.length - bad.length}/${results.length} routes render`);
  for (const b of bad) console.log(`  FAIL  ${b.label.padEnd(16)} ${b.path.padEnd(24)} ${b.detail}`);

  expect(bad.map((b) => `${b.label} (${b.path}): ${b.detail}`), 'routes that did not render').toEqual([]);
});


// THE CHECK THAT KEEPS THIS LIST HONEST.
//
// A hand-written route list drifts the moment someone adds a page, and a coverage suite that silently
// stops covering a new route is worse than none: it reports the same green while covering less. This
// reads `nav.ts` and fails when the app knows about a route this spec does not.
//
// It is the same defect this session kept finding — a check that cannot see the thing it exists for —
// so writing the coverage list without it would have been careless.
test('the route list covers everything the app’s nav offers', async () => {
  // A CWD-RELATIVE PATH, not `new URL(..., import.meta.url)`. That form makes esbuild emit the CJS
  // interop shim, which throws "require is not defined in ES module scope" — reported at line 3, for a
  // call forty lines away, with a caret on a comment. Two wrong fixes before the third stuck; the
  // misleading line number is why. Playwright runs with cwd = this directory.
  const nav = await readFile('../../apps/home/src/components/portal/nav.ts', 'utf8');

  const declared = new Set(
    [...nav.matchAll(/href:\s*'(\/[a-z0-9/-]*)'/g)]
      .map((m) => m[1]!)
      // Org routes are templated here (`/org/<org>/…`) and walked separately, so a literal org href in
      // the nav is covered by the ORG_ROUTES list rather than by path equality.
      .filter((h) => !h.startsWith('/org/')),
  );
  const covered = new Set(PERSON_ROUTES.map((r) => r.path));
  const missing = [...declared].filter((h) => !covered.has(h));

  expect(missing, `nav.ts offers route(s) this coverage spec never walks: ${missing.join(', ')}`).toEqual([]);
});
