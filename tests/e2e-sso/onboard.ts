import { type Page } from '@playwright/test';
import { generatePrivateKey } from 'viem/accounts';
import type { Hex } from 'viem';
import { installMockWallet } from './wallet';

// Onboard a fresh (random) SIWE wallet user through the full flow → returns their SA address + home origin.
export async function onboard(page: Page, name: string, log = (s: string) => console.log(s)): Promise<{ address: `0x${string}`; origin: string; name: string }> {
  return onboardWithKey(page, name, generatePrivateKey(), log);
}

// Onboard a SIWE wallet user with a SPECIFIC private key (deterministic identity) — the reusable core.
// A stable key ⇒ a stable EOA ⇒ a stable SA, so a demo user can be auto-tested run after run (see demo-user.ts).
export async function onboardWithKey(page: Page, name: string, privateKey: Hex, log = (s: string) => console.log(s)): Promise<{ address: `0x${string}`; origin: string; name: string }> {
  const { address } = await installMockWallet(page, privateKey);
  log(`[onboard ${name}] eoa=${address}`);
  await page.goto('/');
  await page.getByRole('button', { name: /Continue with a wallet/i }).click();
  return driveOnboarding(page, name, address, log);
}

/**
 * The onboarding steps AFTER the wallet is wired and the wallet CTA is clicked.
 *
 * Split out because `installMockWallet` calls `page.exposeFunction`, which throws on a second call for the
 * same page ("Function __walletSign has been already registered"). `signInOrOnboard` had already installed
 * the wallet before deciding which path to take, so falling through to `onboardWithKey` installed it twice
 * and killed the run — for a NEW persona only, which is why it survived the first two specs and died on the
 * third. A helper that is safe to call once and fatal to call twice needs the second caller to have a way
 * in that does not repeat it.
 */
export async function driveOnboarding(page: Page, name: string, address: `0x${string}`, log = (s: string) => console.log(s)): Promise<{ address: `0x${string}`; origin: string; name: string }> {
  await page.locator('input:visible').first().waitFor({ timeout: 30_000 });
  await page.locator('input:visible').first().fill(name);
  await page.getByRole('button', { name: new RegExp(`Create ${name}`, 'i') }).click({ timeout: 20_000 });
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: /Get started/i }).first().click().catch(() => {});
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: /Secure with a wallet/i }).first().click().catch(() => {});
  let ok = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(4000);
    const b = await page.locator('body').innerText().catch(() => '');
    if (/Your home is ready/i.test(b)) { ok = true; break; }
    if (/went wrong|AA31|too low/i.test(b)) { log(`[onboard ${name}] SECURE ERROR: ${b.replace(/\n+/g, ' ').slice(0, 160)}`); break; }
  }
  await page.getByRole('button', { name: /^Continue$/i }).first().click().catch(() => {});
  await page.waitForTimeout(6000);
  const act = page.getByRole('button', { name: /Sign \+ activate my vault/i }).first();
  if (await act.count()) { await act.click().catch(() => {}); await page.waitForTimeout(8000); }
  const origin = new URL(page.url()).origin;
  log(`[onboard ${name}] ${ok ? 'DONE' : 'INCOMPLETE'} origin=${origin}`);
  return { address, origin, name };
}


/**
 * SIGN IN if this key already has a home; ONBOARD if it does not.
 *
 * THE GAP THAT MADE `demo-user.ts` DEAD CODE. It promises a stable identity — same key, same Smart Agent,
 * same home, run after run — but `onboardWithKey` is onboarding-only: it clicks through to a name field and
 * fails when that field never appears because the wallet is already recognised. So the stable user worked
 * exactly once, and every spec quietly went back to random throwaways. The helper was not wrong; it was
 * incomplete in a way that only shows up on the SECOND run, which is the run nobody did.
 *
 * A stable cast is worth having precisely because history accumulates, and history means the second run is
 * the normal case rather than the exception.
 */
export async function signInOrOnboard(page: Page, name: string, privateKey: Hex, log = (s: string) => console.log(s)): Promise<{ address: `0x${string}`; origin: string; name: string; existing: boolean }> {
  const { address } = await installMockWallet(page, privateKey);
  await page.goto('/');
  await page.getByRole('button', { name: /Continue with a wallet/i }).first().click().catch(() => {});

  // RACE the two outcomes rather than assuming one. A fixed wait would pick a winner by timing, and the
  // recognised path is the fast one — so a generous timeout would make the NEW-user case look recognised.
  const nameInput = page.locator('input:visible').first();
  const recognised = page.getByRole('link', { name: /^Messages$/ }).first();
  const outcome = await Promise.race([
    nameInput.waitFor({ timeout: 45_000 }).then(() => 'new' as const).catch(() => 'timeout' as const),
    recognised.waitFor({ timeout: 45_000 }).then(() => 'existing' as const).catch(() => 'timeout' as const),
  ]);

  if (outcome === 'existing') {
    const origin = new URL(page.url()).origin;
    log(`[signin ${name}] EXISTING eoa=${address} origin=${origin}`);
    return { address, origin, name, existing: true };
  }
  if (outcome === 'timeout') {
    // Neither appeared. Reported as its own state — "the home is slow" and "the home is broken" are
    // different findings, and returning a plausible origin here would hide both.
    log(`[signin ${name}] NEITHER name-input nor home appeared — ${(await page.locator('body').innerText().catch(() => '')).replace(/\n+/g, ' ').slice(0, 160)}`);
    return { address, origin: new URL(page.url()).origin, name, existing: false };
  }
  // The wallet is already installed and the CTA already clicked — resume from there rather than starting
  // over, which would re-`exposeFunction` and throw.
  const r = await driveOnboarding(page, name, address, log);
  return { ...r, existing: false };
}
