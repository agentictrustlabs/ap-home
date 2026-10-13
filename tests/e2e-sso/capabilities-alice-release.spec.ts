/**
 * The whole loop, on a person whose card is a signed RELEASE: publish a capability, then re-release the
 * card so the world sees it.
 *
 * The capabilities test asserts the chain and stops, because a released card is immutable until
 * re-released (spec 347 §8.1) — correct, and the reason a freshly published capability does not appear
 * on it. This closes that gap by running the ceremony the product actually offers: the card page flags
 * every field that no longer matches what the agent serves, and `Save` will not enable until each one is
 * resolved. That gate is the point — a release says "this is what I am", so it should not be possible to
 * sign one while the page is telling you four fields disagree.
 */
import { test, expect } from '@playwright/test';
import { createPublicClient, http, keccak256, toBytes } from 'viem';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
const AGENT_HOST = process.env.ALICE_AGENT_HOST ?? 'https://alice.faithnet.ai';
const CARD = process.env.ALICE_CARD ?? 'card-396d6fa35967aa02';
const ALICE = '0xb0D11Ce19B756a682E78b4904Cd8D832303b3d11';
const RPC = process.env.FAITHNET_RPC ?? 'https://rpc.faithnet.io/';
const PROFILE_RESOLVER = (process.env.PROFILE_RESOLVER ?? '0xB03F7C06ad3274F584AB72794406D639c02A45e1') as `0x${string}`;
const PROFILE_ABI = [{
  type: 'function', name: 'getStringProperty', stateMutability: 'view',
  inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'string' }],
}] as const;
async function readCapabilityIds(agent: string): Promise<string> {
  const client = createPublicClient({ transport: http(RPC) });
  return (await client.readContract({
    address: PROFILE_RESOLVER, abi: PROFILE_ABI, functionName: 'getStringProperty',
    args: [agent as `0x${string}`, keccak256(toBytes('atl:capabilities'))],
  })) as string;
}

/** A stable, obviously-demo capability. Not a run-unique id: this one is SIGNED and PUBLISHED under a
 *  person's identity, and a public card should say something meant, not an accumulation of test debris. */
const CAP_NAME = 'demo capability walkthrough';
const CAP_ID = 'demo-capability-walkthrough';
const CAP_DESC = 'Demonstrates the capability → card → ARD chain end to end.';

test('alice replaces her published capabilities, then re-releases her card', async ({ page, request }) => {
  test.setTimeout(600_000);
  page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 160)); });

  const signin = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'alice', client_id: 'demo-jp' } });
  const { homeSession } = (await signin.json()) as { homeSession: string };

  // ── 1. Capabilities: clear the accumulated e2e rows, keep one meant one. ──
  await page.goto(`${HOME}/capabilities#session=${homeSession}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /what this agent can do/i })).toBeVisible({ timeout: 60_000 });
  // ESTABLISH PRESENCE BEFORE ASSERTING ABSENCE. The first version of this went straight to
  // `toHaveCount(0)` and passed vacuously — the rows had not loaded yet, so "none present" was true for
  // the wrong reason and the cleanup silently never ran. Wait for the list to resolve either way first.
  await expect
    .poll(async () => (await page.locator('[data-capability]').count()) > 0
      || (await page.getByText(/Nothing in your capability record yet/i).count()) > 0,
      { timeout: 60_000 })
    .toBe(true);

  // Remove one at a time: each removal re-renders the list, so a snapshot of handles goes stale.
  for (let guard = 0; guard < 30; guard++) {
    const stale = page.getByRole('button', { name: /^remove e2e capability/i });
    if (await stale.count() === 0) break;
    await stale.first().click();
    await page.waitForTimeout(500);
  }
  await expect(page.getByRole('button', { name: /^remove e2e capability/i })).toHaveCount(0);

  if (await page.locator(`[data-capability="${CAP_ID}"]`).count() === 0) {
    await page.getByPlaceholder(/treasury management/i).fill(CAP_NAME);
    await page.getByRole('button', { name: /^Add$/ }).click();
  }
  const row = page.locator(`[data-capability="${CAP_ID}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByLabel(`description for ${CAP_NAME}`).fill(CAP_DESC);
  if (await row.getByText(/○ Private/).count()) await row.getByLabel(`toggle publishing ${CAP_NAME}`).click();
  await expect(row.getByText(/● Published/)).toBeVisible();

  // Idempotent: the button disables itself when the chain already matches the record, and a rerun that
  // changed nothing should not fail for lack of something to publish.
  const publish = page.getByRole('button', { name: /^Publish (for discovery|& update card draft)$/i });
  if (await publish.isEnabled()) {
    await publish.click();
    await expect(page.getByText(/now advertise these capabilities|Cleared what you publish/i)).toBeVisible({ timeout: 180_000 });
  } else {
    expect(await publish.getAttribute('title'), 'disabled only because it is already up to date').toMatch(/up to date/i);
  }

  // The chain is the record. Assert the debris is GONE from it, not merely from the editor's list.
  await expect
    .poll(() => readCapabilityIds(ALICE), { timeout: 120_000, intervals: [5_000] })
    .toBe(CAP_ID);

  // ── 2. The card page flags what no longer matches; the fix is in the editor. ──
  // "Fix this" NAVIGATES to the field — it resolves nothing on its own, which is why clicking it in a
  // loop cleared the list from view without changing anything.
  await page.goto(`${HOME}/card/${CARD}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: /^Save$/ })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: /^Fix this$/ }).first().click();
  await expect(page.getByRole('heading', { name: /advertised capabilities/i }).first()).toBeVisible({ timeout: 30_000 });

  // The served capability is offered from the catalog; adding it is what makes the card match. Already
  // on the card (a rerun, or a partial earlier attempt) ⇒ nothing to add, which is success, not a miss.
  const onCard = page.getByRole('button', { name: new RegExp(`Remove ${CAP_ID} from this card`, 'i') });
  if (await onCard.count() === 0) {
    const offer = page.getByRole('button', { name: /^Add$/ }).first();
    await expect(offer, 'the served capability is offered from the catalog').toBeVisible({ timeout: 30_000 });
    await offer.click();
  }
  await expect(onCard, 'the capability is on the card').toHaveCount(1, { timeout: 30_000 });

  // ── 3. Save = create, sign and publish the release. The gate must have cleared on its own. ──
  const save = page.getByRole('button', { name: /^Save$/ });
  await expect(save, 'the divergence is resolved, so signing is allowed').toBeEnabled({ timeout: 60_000 });
  await save.click();
  await expect(page.getByText(/Saved ✓|serving what you saved/i).first()).toBeVisible({ timeout: 300_000 });

  // ── 4. The SERVED card carries it — the whole point of re-releasing. ──
  await expect
    .poll(async () => {
      const r = await request.get(`${AGENT_HOST}/.well-known/agent-card.json`, { headers: { 'cache-control': 'no-cache' } });
      if (!r.ok()) return `HTTP ${r.status()}`;
      const c = (await r.json()) as { skills?: Array<{ id: string }> };
      return (c.skills ?? []).map((s) => s.id).join(',');
    }, { timeout: 240_000, intervals: [10_000] })
    .toContain(CAP_ID);

  // and so does ARD, which derives from that same served card.
  await expect
    .poll(async () => {
      const r = await request.get(`${AGENT_HOST}/.well-known/ard.json`, { headers: { 'cache-control': 'no-cache' } });
      const ard = (await r.json()) as { entries?: Array<{ capabilities?: string[] }> };
      return (ard.entries ?? []).flatMap((e) => e.capabilities ?? []);
    }, { timeout: 120_000, intervals: [10_000] })
    .toContain(CAP_ID);

  // The e2e debris is gone from the public card, not merely hidden in the editor.
  const finalCard = (await (await request.get(`${AGENT_HOST}/.well-known/agent-card.json`)).json()) as { skills: Array<{ id: string }> };
  expect(finalCard.skills.map((s) => s.id).filter((id) => id.startsWith('e2e-capability-'))).toEqual([]);
});
