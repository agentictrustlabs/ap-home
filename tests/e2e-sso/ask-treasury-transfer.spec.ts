/**
 * Nathan tells his agent to move money between two treasuries, in words, from the Ask.
 *
 *   "send 5 usdc from nathan.treasury to alice2.treasury"
 *
 * Everything the enforcers need is derived from that sentence — both agents by NAME, this deployment's
 * token, the ceiling — before Nathan is shown what he is granting. Three failures this asserts against,
 * each of which produced a confident wrong answer in practice:
 *
 *   the agent LOOKS UP the names and stops, explaining that no transfer was made (a lookup offered beside
 *   an action is the safest-looking thing a planner can choose);
 *   the mandate names a token from the model's MEMORY — Base Sepolia's USDC is address-shaped, plausible,
 *   and not on this chain;
 *   the run judges the words rather than the addresses, and denies a payment whose mandate was correct.
 *
 * The assertion is the chain: the balances move, or they do not.
 */
import { test, expect } from '@playwright/test';
import { createPublicClient, http, parseEventLogs, parseAbi } from 'viem';

const TRANSFER_EVENT = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
const RPC = process.env.FAITHNET_RPC ?? 'https://a2a.faithnet.io/rpc';
const USDC = (process.env.MOCK_USDC ?? '0xdaE09066A2cc32f6203605619137dcF01A9B49Ae') as `0x${string}`;
const FROM = (process.env.NATHAN_TREASURY ?? '0x2c471607FeC409516ab6DE6b7517bcF95F1f2edc') as `0x${string}`;
const TO = (process.env.ALICE2_TREASURY ?? '0x5ef5360A41F31e55541117a854455C0dA0Fb67B3') as `0x${string}`;
const USDC_AMOUNT = 1n;

const bal = async (a: `0x${string}`): Promise<bigint> =>
  createPublicClient({ transport: http(RPC) }).readContract({
    address: USDC,
    abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf', args: [a],
  }) as Promise<bigint>;

test('nathan moves USDC between treasuries by asking for it', async ({ page, request }) => {
  test.setTimeout(300_000);
  const signin = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'nathan', client_id: 'demo-jp' } });
  expect(signin.ok(), 'demo-signin').toBeTruthy();
  const { homeSession } = (await signin.json()) as { homeSession: string };
  const before = { from: await bal(FROM), to: await bal(TO) };
  test.skip(before.from < USDC_AMOUNT * 1_000_000n, 'nathan.treasury has nothing to send');

  await page.goto(`${HOME}/#session=${homeSession}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('ask-toggle')).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(2_000);

  await page.getByTestId('ask-toggle').click();
  await page.getByTestId('ask-input').fill(`send ${USDC_AMOUNT} usdc from nathan.treasury to alice2.treasury`);
  await page.getByTestId('ask-input').press('Enter');

  // It must ask for AUTHORITY — not answer with the two addresses it looked up.
  const authority = page.getByTestId('ask-authority');
  await expect(authority, 'an instruction is answered by the capability that performs it').toBeVisible({ timeout: 120_000 });
  await expect(authority).toContainText(/make payments/i);
  await page.getByTestId('ask-grant').click();

  // A payment is high risk: the ladder wants a second party, and asks rather than refusing.
  const prompt = page.getByTestId('ask-prompt');
  await expect(prompt).toBeVisible({ timeout: 120_000 });
  await expect(prompt).toContainText(/second party to approve/i);
  await page.getByTestId('ask-answer').click();

  // THE TRANSFER THIS ASK MADE, not the balance of a shared account over a window. Both treasuries are
  // demo estate that other specs also spend from, and a payment of theirs settling inside this window is
  // indistinguishable from this one going wrong: the payer's balance fell by 2 USDC on a run where this
  // ask moved 1, and the failure said "nathan.treasury pays it" about a payment that was correct. The
  // run's own receipt is not ambiguous — decode it.
  const tx = page.getByTestId('ask-tx');
  await expect(tx, 'a payment reports the transaction it made').toBeVisible({ timeout: 240_000 });
  const txHash = (await tx.getAttribute('data-tx')) as `0x${string}`;
  const receipt = await createPublicClient({ transport: http(RPC) }).getTransactionReceipt({ hash: txHash });
  expect(receipt.status, 'the transaction succeeded').toBe('success');
  const transfers = parseEventLogs({ abi: TRANSFER_EVENT, logs: receipt.logs })
    .filter((l) => l.address.toLowerCase() === USDC.toLowerCase());
  const moved = transfers.find(
    (l) => l.args.from.toLowerCase() === FROM.toLowerCase() && l.args.to.toLowerCase() === TO.toLowerCase(),
  );
  expect(moved, `this ask moved USDC from nathan.treasury to alice2.treasury (saw ${JSON.stringify(transfers.map((l) => `${l.args.from}→${l.args.to}:${l.args.value}`))})`).toBeTruthy();
  expect(moved!.args.value, 'for the amount asked').toBe(USDC_AMOUNT * 1_000_000n);

  // And it really did land: the recipient's balance is the chain agreeing with the receipt.
  await expect.poll(async () => (await bal(TO)) - before.to, { timeout: 60_000, intervals: [4_000] })
    .toBeGreaterThanOrEqual(USDC_AMOUNT * 1_000_000n);
});
