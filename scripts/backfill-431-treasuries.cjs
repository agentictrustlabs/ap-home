/**
 * SPEC 431 W2 BACKFILL — every demo persona's treasury, with its 1,000 SHQ (ap-town spec 431 D2).
 *
 *   node scripts/backfill-431-treasuries.cjs [HOME_URL] [persona ...]
 *
 * Opens the Home in a browser as each persona (the "Demo people" sign-in; demo custody is held by the Home, so the
 * ceremonies are promptless) and lets the session's own birthright effect (src/context/session.tsx) make the treasury
 * and mint the balance. Nothing here signs: the Home does, as the persona. Social-custody people get theirs on
 * their next sign-in by the same effect; passkey and wallet homes at their first purchase.
 */
const { chromium } = require('/home/barb/ap-home/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright');
const HOME = process.argv[2] && /^https?:/.test(process.argv[2]) ? process.argv[2] : 'https://www.faithnet.me';
const only = process.argv.slice(/^https?:/.test(process.argv[2] ?? '') ? 3 : 2);

(async () => {
  const b = await chromium.launch();
  const page = await (await b.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  await page.goto(`${HOME}/`, { waitUntil: 'networkidle' });
  await page.getByText('Demo people').click();
  await page.waitForTimeout(500);
  const names = await page.$$eval('button', (els) => els.map((e) => e.textContent?.trim() ?? '').filter((t) => /^[A-Z][a-z]+ [A-Z]/.test(t)));
  const todo = only.length ? names.filter((n) => only.some((o) => n.toLowerCase().includes(o.toLowerCase()))) : names;
  console.log(`${todo.length} persona(s): ${todo.join(', ')}`);
  for (const name of todo) {
    const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
    const p = await ctx.newPage();
    const logs = [];
    p.on('console', (m) => { if (/treasury|birthright/i.test(m.text())) logs.push(m.text()); });
    try {
      await p.goto(`${HOME}/`, { waitUntil: 'networkidle' });
      await p.getByText('Demo people').click();
      await p.getByRole('button', { name }).first().click();
      await p.waitForTimeout(2500);
      // Wait for the birthright memo to appear (the effect finished), up to 90 s.
      const ok = await p.waitForFunction(() => Object.keys(localStorage).some((k) => k.startsWith('ap-treasury-birthright:')), null, { timeout: 90_000 }).then(() => true).catch(() => false);
      console.log(`${ok ? '✓' : '✗'} ${name}${logs.length ? ` — ${logs.join(' | ')}` : ''}`);
    } catch (e) { console.log(`✗ ${name}: ${String(e).slice(0, 160)}`); }
    await ctx.close();
  }
  await b.close();
})();
