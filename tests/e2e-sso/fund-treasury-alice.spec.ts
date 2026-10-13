/**
 * FUNDING A TREASURY FROM THE HOME — the exact walk a person takes: Stewardship → Treasuries →
 * alice2.treasury → Fund with USDC.
 *
 * Two things are under test, and the second is the one that broke. The first is that the mint lands: the
 * treasury's on-chain balance goes up by what was asked for. The second is that it lands WITHOUT A WALLET
 * PROMPT for a home whose custodian key the Home itself holds — `fundTreasury` had never learned the
 * demo-custody branch its sibling ceremonies use, so it called `connectWallet()` and MetaMask appeared
 * under a note promising it would not. In a browser with no wallet at all, that failure is not cosmetic:
 * there is nothing to sign with, and the ceremony simply cannot complete.
 *
 * This page has no wallet extension. If the code reaches for one, this test fails — which is exactly the
 * assertion we want.
 */
import { test, expect } from '@playwright/test';
import { createPublicClient, http } from 'viem';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
const RPC = process.env.FAITHNET_RPC ?? 'https://a2a.faithnet.io/rpc';
const USDC = (process.env.MOCK_USDC ?? '0xdaE09066A2cc32f6203605619137dcF01A9B49Ae') as `0x${string}`;
const TREASURY = (process.env.ALICE2_TREASURY ?? '0x5ef5360A41F31e55541117a854455C0dA0Fb67B3') as `0x${string}`;
const AMOUNT = 7; // whole USDC

const balanceOf = async (): Promise<bigint> =>
  createPublicClient({ transport: http(RPC) }).readContract({
    address: USDC,
    abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [TREASURY],
  }) as Promise<bigint>;

test('alice funds alice2.treasury with USDC — and is never sent to a wallet', async ({ page, request }) => {
  const signin = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'alice', client_id: 'demo-jp' } });
  expect(signin.ok(), 'demo-signin').toBeTruthy();
  const { homeSession } = (await signin.json()) as { homeSession: string };

  const before = await balanceOf();
  await page.goto(`${HOME}/treasuries#session=${homeSession}`, { waitUntil: 'domcontentloaded' });

  // The treasury is on the page by name, under Personal.
  const card = page.locator('.manage-card', { hasText: 'alice2.treasury' }).first();
  await expect(card, 'alice2.treasury on the Treasuries page').toBeVisible({ timeout: 30_000 });

  // The note must say what THIS session will do — a promise of "no wallet prompt" is only true for a home
  // that signs for you, and saying it to a wallet home is how this went wrong.
  await card.getByRole('button', { name: /fund with usdc/i }).click();
  await expect(card).toContainText(/gas is sponsored/i);
  await expect(card).toContainText(/home signs it: no wallet prompt/i);

  await card.locator('input').first().fill(String(AMOUNT));
  await card.getByRole('button', { name: /^fund$/i }).click();

  // No wallet exists in this browser: if the ceremony reaches for one it fails here rather than hanging.
  await expect(card.locator('.onboarding-hint.taken, .ask-err')).toHaveCount(0, { timeout: 5_000 }).catch(() => undefined);
  await expect(card.getByRole('button', { name: /fund with usdc/i }), 'the form closes when funding succeeds')
    .toBeVisible({ timeout: 120_000 });

  // The chain is the assertion, not the UI: the mint either landed or it did not.
  const deadline = Date.now() + 90_000;
  let after = before;
  while (Date.now() < deadline && after === before) {
    await page.waitForTimeout(3_000);
    after = await balanceOf();
  }
  expect(after - before, `alice2.treasury balance should rise by ${AMOUNT} USDC`).toBe(BigInt(AMOUNT) * 1_000_000n);
});
