import { expect, test } from '@playwright/test';

process.env.NEXT_PUBLIC_CHAIN_ID ??= '34348';
const { whitelabel } = await import('../../apps/home/src/whitelabel/config');

// Spec 445 §16. Every app in a Home's sign-out chain is a top-level navigation: one that does not send the person back strands them.
// So each is checked, live, the way the chain uses it. No session, nothing signed.
const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
for (const uri of whitelabel.frontChannelLogout?.[HOME] ?? []) {
  test(`${new URL(uri).host} sends a person back to the Home`, async ({ page }) => {
    const back = `${HOME}/logout?fc=99&return=${encodeURIComponent(`${HOME}/jwks`)}`;
    await page.goto(`${uri}?return=${encodeURIComponent(back)}`);
    await page.waitForURL((u) => u.origin === HOME, { timeout: 15_000 });
    expect(new URL(page.url()).origin).toBe(HOME);
  });
}
