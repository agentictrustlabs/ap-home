import { test, type Page } from '@playwright/test';
import { generatePrivateKey } from 'viem/accounts';
import { installMockWallet } from './wallet';

// Comprehensive feature sweep of the Home (`apps/home`) against PRODUCTION with a generated SIWE wallet.
// Onboards one demo user, then exercises every portal area, recording PASS/FAIL per feature.

const results: { feature: string; ok: boolean; detail: string }[] = [];
function record(feature: string, ok: boolean, detail = '') { results.push({ feature, ok, detail }); console.log(`${ok ? '✓ PASS' : '✗ FAIL'} [${feature}] ${detail}`); }

function wire(page: Page) {
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
  page.on('response', async (r) => {
    const u = r.url();
    if ((u.includes('/connect/') || u.includes('/a2a/')) && r.status() >= 400) {
      const b = await r.text().catch(() => '');
      console.log(`[http-${r.status()}] ${u.replace(/https:\/\/[a-z0-9.]+\.faithnet\.(me|io|ai)/, '')} :: ${b.slice(0, 160)}`);
    }
  });
}
async function dump(page: Page, label: string) { await page.screenshot({ path: `artifacts/ff-${label}.png`, fullPage: true }).catch(() => {}); }
async function body(page: Page): Promise<string> { return (await page.locator('body').innerText().catch(() => '')).replace(/\n+/g, ' | '); }
async function nav(page: Page, name: RegExp): Promise<boolean> {
  const link = page.getByRole('link', { name }).first();
  if (!(await link.count())) return false;
  await link.click().catch(() => {});
  await page.waitForTimeout(4000);
  return true;
}

test('feature sweep: all of the Home', async ({ page }) => {
  test.setTimeout(600_000);
  const pk = generatePrivateKey();
  await installMockWallet(page, pk);
  const name = 'demo' + Date.now().toString(36);
  console.log('=== DEMO USER === name=%s pk=%s', name, pk);
  wire(page);

  // ── Onboard ──────────────────────────────────────────────────────────────
  await page.goto('/');
  await page.getByRole('button', { name: /Continue with a wallet/i }).click();
  await page.locator('input:visible').first().waitFor({ timeout: 30_000 });
  await page.locator('input:visible').first().fill(name);
  await page.getByRole('button', { name: new RegExp(`Create ${name}`, 'i') }).click({ timeout: 20_000 });
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: /Get started/i }).first().click().catch(() => {});
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: /Secure with a wallet/i }).first().click().catch(() => {});
  let secured = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(4000);
    const b = await body(page);
    if (/Your home is ready/i.test(b)) { secured = true; break; }
    if (/went wrong|AA31|too low|error/i.test(b)) { record('onboard.secure', false, b.slice(0, 160)); break; }
  }
  record('onboard.secure', secured, secured ? 'home founded + name registered' : 'securing did not complete');
  await page.getByRole('button', { name: /^Continue$/i }).first().click().catch(() => {});
  await page.waitForTimeout(6000);
  const activate = page.getByRole('button', { name: /Sign \+ activate my vault/i }).first();
  if (await activate.count()) { await activate.click().catch(() => {}); await page.waitForTimeout(8000); }
  record('onboard.vault-activate', /Home|Organizations|Profile/.test(await body(page)), 'reached portal');
  await dump(page, '00-portal');

  // ── Profile (save + reload persistence) ────────────────────────────────────
  if (await nav(page, /^Profile$/)) {
    const fn = page.locator('input:visible').first();
    if (await fn.count()) {
      await fn.fill('Rich');
      const inputs = page.locator('input:visible');
      if (await inputs.count() > 1) await inputs.nth(1).fill('Pedersen').catch(() => {});
      await page.getByRole('button', { name: /^Save/i }).first().click().catch(() => {});
      await page.waitForTimeout(7000);
      const saved = /Saved/i.test(await body(page));
      await page.reload(); await page.waitForTimeout(7000);
      const val = await page.locator('input:visible').first().inputValue().catch(() => '');
      record('profile.save+persist', saved && val === 'Rich', `saved=${saved} reloadValue="${val}"`);
    } else record('profile.save+persist', false, 'no input (blocked: ' + (await body(page)).slice(0, 100) + ')');
  } else record('profile.save+persist', false, 'no Profile nav');
  await dump(page, '01-profile');

  // ── Naming (records/properties) ────────────────────────────────────────────
  if (await nav(page, /^Naming$/)) {
    record('naming.view', /naming|name|record|propert/i.test(await body(page)), (await body(page)).slice(0, 120));
  } else record('naming.view', false, 'no Naming nav');
  await dump(page, '02-naming');

  // ── Security (credentials) ─────────────────────────────────────────────────
  if (await nav(page, /^Security$/)) {
    record('security.view', /credential|passkey|wallet|security|recovery/i.test(await body(page)), (await body(page)).slice(0, 120));
  } else record('security.view', false, 'no Security nav');
  await dump(page, '03-security');

  // ── Skills / Metadata / Activity / Messages (read views) ───────────────────
  for (const [feat, re] of [['skills', /^Skills$/], ['metadata', /^Metadata$/], ['activity', /^Activity$/], ['messages', /^Messages$/]] as const) {
    if (await nav(page, re)) record(`${feat}.view`, !/went wrong|error 5|Could not/i.test(await body(page)), (await body(page)).slice(0, 100));
    else record(`${feat}.view`, false, `no ${feat} nav`);
    await dump(page, `04-${feat}`);
  }

  // ── Org create ─────────────────────────────────────────────────────────────
  const orgName = 'org' + Date.now().toString(36);
  if (await nav(page, /^Organizations$/)) {
    // Exact "Create organization" — NOT the topbar "Add organization" (AgentSwitcher dropdown).
    await page.getByRole('button', { name: 'Create organization', exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(1500);
    const oi = page.locator('input:visible').first();
    if (await oi.count()) {
      await oi.fill(orgName);
      await page.getByRole('button', { name: /Create \+ name|^Create$/i }).first().click().catch(() => {});
      let created = false;
      for (let i = 0; i < 14; i++) {
        await page.waitForTimeout(5000);
        const b = await body(page);
        if (/went wrong|AA31|too low|failed/i.test(b)) { record('org.create', false, b.slice(0, 160)); break; }
        if (new RegExp(orgName, 'i').test(b) && /ORGANIZATION|Custodied by you/i.test(b)) { created = true; break; }
      }
      record('org.create', created, created ? `org "${orgName}.impact" created` : 'org did not appear');
    } else record('org.create', false, 'no org name input after reveal');
  } else record('org.create', false, 'no Organizations nav');
  await dump(page, '05-org-create');

  // ── Channels: navigate to the org's channels route (via its explorer-link address) ──
  const expHref = await page.locator('a[href*="0x"]').first().getAttribute('href').catch(() => null);
  const orgAddr = expHref?.match(/0x[0-9a-fA-F]{40}/)?.[0];
  if (orgAddr) {
    const origin = new URL(page.url()).origin; // stay on the subdomain to keep the session
    await page.goto(`${origin}/org/${orgAddr}/channels`);
    await page.waitForTimeout(6000);
    // membership: spec 321 seeds the steward onto the roster at org create; the self-add CTA is the
    // fallback for pre-seeding orgs.
    const addMe = page.getByRole('button', { name: /Add yourself as member/i }).first();
    if (await addMe.count()) {
      const dn = page.getByPlaceholder(/Display name/i).first();
      if (await dn.count()) await dn.fill('Rich P').catch(() => {});
      await addMe.click().catch(() => {});
      let member = false;
      // THE ROSTER HEADER SAYS "Participants · N". This matched only /members ·/, so it could never see a
      // roster no matter what the product did — the identical defect `discussions.spec.ts` carried in
      // `memberCount`, found there first and swept for here. Accepts either word rather than swapping one
      // hard-coded label for another: a test that breaks on a rename is what produced this.
      const ROSTER = /(participants|members) · [1-9]/i;
      for (let i = 0; i < 8; i++) { await page.waitForTimeout(4000); if (ROSTER.test(await body(page))) { member = true; break; } }
      record('channels.add-member', member, member ? 'listed via self-add CTA' : 'roster still 0 after self-add');
    } else record('channels.add-member', /(participants|members) · [1-9]/i.test(await body(page)), 'auto-listed at org create');
    await dump(page, '06-member');
    // create channel: sidebar ＋ (title="New channel") → topic input → Create
    await page.locator('button[title="New channel"]').first().click().catch(() => {});
    await page.waitForTimeout(1000);
    const ch = page.getByPlaceholder(/Topic, e\.g\./).first();
    if (await ch.count()) {
      await ch.fill('general2');
      await page.getByRole('button', { name: 'Create', exact: true }).first().click().catch(() => {});
      // Poll for the new channel to appear (like channels.post below): the gcp-kms envelope adds a
      // Cloud KMS round-trip per InteractionsDO session op, so the sidebar/header can take longer than
      // a single fixed wait to reflect the create. The channel IS created (channels.post posts into it).
      let created = false;
      for (let i = 0; i < 7; i++) {
        await page.waitForTimeout(4000);
        if (/general2/i.test(await body(page))) { created = true; break; }
      }
      record('channels.create', created, 'channel general2');
    } else record('channels.create', false, 'no topic input after ＋');
    await dump(page, '07-channel');
    // post a message into the active channel (Enter sends)
    const msg = page.locator('textarea[placeholder^="Message #"]').first();
    if (await msg.count()) {
      await msg.fill('hello from playwright');
      await msg.press('Enter');
      let posted = false;
      for (let i = 0; i < 7; i++) {
        await page.waitForTimeout(4000);
        if ((await page.locator('.chat-thread-body').first().innerText().catch(() => '')).includes('hello from playwright')) { posted = true; break; }
        // Enter during an in-flight action is silently dropped (canSend=false) — re-send if the draft remains
        if (i >= 1 && (await msg.inputValue().catch(() => '')) === 'hello from playwright') await msg.press('Enter');
      }
      record('channels.post', posted, 'message posted + read back in thread');
    } else record('channels.post', false, 'no message composer');
    await dump(page, '08-post');
  } else record('channels.add-member', false, 'no org to open');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n========== FEATURE SWEEP RESULTS ==========');
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.feature} — ${r.detail}`);
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} features passed`);
});
