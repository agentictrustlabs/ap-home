import { test, expect } from '@playwright/test';
import { signInAsSeededPerson } from './onboard';

// Spec 445 §6: an app that asks for the person to be asked gets that, whether or not its request names a Home. Reads only: it stops at the credential screen.
test('prompt=login, naming no Home, ends at the credential screen with no code', async ({ page }) => {
  await signInAsSeededPerson(page);
  const q = new URLSearchParams({ client_id: 'seed-bible-reader', redirect_uri: 'https://seed-reader.faithnet.io/', state: 's', nonce: 'n', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', delegation_template: 'site-login', delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0', prompt: 'login' });
  await page.goto(`/?${q}`);
  await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(4000);
  await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible();
  expect(new URL(page.url()).hostname).toBe('www.faithnet.me');
  expect(new URL(page.url()).searchParams.get('code')).toBeNull();
});
