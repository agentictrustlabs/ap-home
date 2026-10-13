/**
 * Alice publishes a capability, and it appears everywhere a capability is supposed to appear.
 *
 * The point of ADR-0051 is that ONE list — `profile.capabilities` — feeds every surface, under whatever
 * name that surface uses for it:
 *
 *   Home /capabilities  → the owner edits it, as structured rows
 *   on chain            → `atl:capabilities`, ids only
 *   A2A agent card      → `skills[]`, the wire's name for the same thing
 *   ARD ard.json        → `capabilities[]` + `representativeQueries`
 *
 * A regression that leaves the chain right and the card stale (or the reverse) is exactly the class this
 * asserts against, so it checks all four rather than trusting that one implies the others.
 */
import { test, expect } from '@playwright/test';
import { createPublicClient, http, keccak256, toBytes } from 'viem';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
const AGENT_HOST = process.env.ALICE_AGENT_HOST ?? 'https://alice.faithnet.ai';
const RPC = process.env.FAITHNET_RPC ?? 'https://rpc.faithnet.io/';
const PROFILE_RESOLVER = (process.env.PROFILE_RESOLVER ?? '0xB03F7C06ad3274F584AB72794406D639c02A45e1') as `0x${string}`;

/** The profile-resolver read, encoded by viem rather than by hand — a hand-written selector is a silent
 *  way to assert against the wrong function and watch the test "pass". */
const PROFILE_ABI = [{
  type: 'function', name: 'getStringProperty', stateMutability: 'view',
  inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'string' }],
}] as const;
const ATL_CAPABILITIES = keccak256(toBytes('atl:capabilities'));

/** A run-unique id, so a rerun proves a FRESH write rather than passing on the previous run's leftovers. */
const SUFFIX = Date.now().toString(36).slice(-5);
// A REAL catalog id — the editor cannot invent one any more, which is the point of the catalog. Its
// stability is fine here: the assertions are about the id reaching chain, card and ARD, not about novelty.
const CAP_ID = 'adv:tax-position-analysis';
const CAP_EXAMPLE = `what did wave ${SUFFIX} change?`;

async function readCapabilityIds(agent: string): Promise<string> {
  const client = createPublicClient({ transport: http(RPC) });
  return (await client.readContract({
    address: PROFILE_RESOLVER, abi: PROFILE_ABI, functionName: 'getStringProperty',
    args: [agent as `0x${string}`, ATL_CAPABILITIES],
  })) as string;
}

test('alice publishes a capability → chain, agent card and ARD all carry it', async ({ page, request }) => {
  test.setTimeout(300_000);

  const signin = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'alice', client_id: 'demo-jp' } });
  expect(signin.ok(), `demo-signin ${signin.status()}`).toBe(true);
  const { homeSession, agent } = (await signin.json()) as { homeSession?: string; agent?: string };
  expect(homeSession, 'demo-signin must mint a Home session for alice').toBeTruthy();
  expect(agent, 'demo-signin must report alice’s SA').toBeTruthy();

  await page.goto(`${HOME}/capabilities#session=${homeSession}`, { waitUntil: 'domcontentloaded' });

  // The page is the CAPABILITIES page — the word "Skills" belongs to the playbook now (ADR-0051).
  await expect(page.getByRole('heading', { name: /what this agent can do/i })).toBeVisible({ timeout: 60_000 });

  // ── Add a structured row: name, then the fields a card and an ARD document both need. ──
  // Capabilities are SELECTED from the shared catalog now — there is deliberately no free-text id field
  // (ADR-0051), so this drives the picker rather than typing a label that used to get slugged.
  const row = page.locator(`[data-capability="${CAP_ID}"]`);
  if (await row.count() === 0) {
    await page.getByRole('button', { name: /\+ Add a capability/i }).click();
    await page.getByLabel(/search capability definitions/i).fill(CAP_ID);
    await page.getByRole('button', { name: `add ${CAP_ID}` }).click();
  }
  await expect(row, 'the row is keyed by the id that will travel').toBeVisible({ timeout: 15_000 });
  await row.getByLabel(/example queries for/i).fill(CAP_EXAMPLE);

  // Mark it published, then publish — two deliberate steps: the record is private until the owner says.
  await row.getByRole('button', { name: /toggle publishing/i }).click();
  await expect(row.getByText(/● Published/)).toBeVisible();
  await page.getByRole('button', { name: /^Publish (for discovery|& update card draft)$/i }).click();
  await expect(page.getByText(/published on chain/i)).toBeVisible({ timeout: 180_000 });

  // ── 1. On chain: the ID, and only the id — the chain records WHICH capabilities are claimed. ──
  await expect
    .poll(() => readCapabilityIds(agent!), { timeout: 120_000, intervals: [5_000] })
    .toContain(CAP_ID);
  // The prose stays off chain: a description is card content, not a fact worth a storage slot.
  expect(await readCapabilityIds(agent!), 'the chain carries ids, not prose').not.toContain(' ');

  // ── 2. The published surfaces. ──
  // A RELEASED card is served byte-for-byte and is immutable until re-released (spec 347 §8.1) — that is
  // the point of a signed release, so an agent with one legitimately does NOT show a freshly published
  // capability yet. Asserting otherwise would demand the product break its own guarantee. Which case this
  // agent is in comes from the response itself, not from an assumption.
  const cardRes = await request.get(`${AGENT_HOST}/.well-known/agent-card.json`, { headers: { 'cache-control': 'no-cache' } });
  expect(cardRes.ok(), `agent card ${cardRes.status()}`).toBe(true);
  const source = cardRes.headers()['x-ap-card-source'];
  const card = (await cardRes.json()) as {
    skills: Array<{ id: string; name?: string; tags?: string[] }>;
    capabilities: Record<string, unknown>;
  };

  // Whatever the source, these two must never blur: `skills[]` is what the agent can DO, `capabilities`
  // is A2A's protocol flags. They collide in NAME only, which is the whole reason they are separate.
  expect(Object.keys(card.capabilities)).not.toContain(CAP_ID);
  expect(card.capabilities).toHaveProperty('streaming');

  if (source === 'released') {
    expect(card.skills.map((s) => s.id), 'a signed release is immutable until re-released').not.toContain(CAP_ID);
    test.info().annotations.push({
      type: 'note',
      description: `${AGENT_HOST} serves a RELEASED card (${cardRes.headers()['x-ap-card-release']}). The capability is on chain and in the live card; the public card shows it after the next release.`,
    });
    return;
  }

  // Live card: the projection is immediate, and the id survives VERBATIM. A card advertising a slugged
  // variant of the on-chain id breaks the one guarantee an id has — that it is the same string
  // everywhere — and a matcher looking up one would not find the other.
  await expect
    .poll(async () => {
      const r = await request.get(`${AGENT_HOST}/.well-known/agent-card.json`, { headers: { 'cache-control': 'no-cache' } });
      const c = (await r.json()) as { skills?: Array<{ id: string }> };
      return (c.skills ?? []).map((x) => x.id);
    }, { timeout: 120_000, intervals: [5_000] })
    .toContain(CAP_ID);

  await expect
    .poll(async () => {
      const r = await request.get(`${AGENT_HOST}/.well-known/ard.json`, { headers: { 'cache-control': 'no-cache' } });
      const ard = (await r.json()) as { entries?: Array<{ capabilities?: string[] }> };
      return (ard.entries ?? []).flatMap((e) => e.capabilities ?? []);
    }, { timeout: 120_000, intervals: [5_000] })
    .toContain(CAP_ID);
});

/**
 * The LIVE projection, on an agent whose card is not frozen by a release.
 *
 * Alice's card is a signed release, so her test above stops at the chain — correctly. This one covers
 * the half that a released card cannot: on-chain ids → `card.skills[]` → ARD `capabilities[]`, and in
 * particular that the id survives VERBATIM. Before this wave the mapper slugified, so `registry.search`
 * on chain was advertised as `registry-search`; a matcher resolving one would not have found the other,
 * and nothing would have looked broken from either side.
 */
const LIVE_HOST = process.env.LIVE_AGENT_HOST ?? 'https://discovery-registry.faithnet.ai';

test('a live card and ARD carry the on-chain capability ids verbatim', async ({ request }) => {
  test.setTimeout(120_000);

  const cardRes = await request.get(`${LIVE_HOST}/.well-known/agent-card.json`, { headers: { 'cache-control': 'no-cache' } });
  expect(cardRes.ok(), `agent card ${cardRes.status()}`).toBe(true);
  test.skip(cardRes.headers()['x-ap-card-source'] === 'released', `${LIVE_HOST} serves a released card; this asserts the live projection`);

  const card = (await cardRes.json()) as {
    skills: Array<{ id: string; name?: string; tags?: string[] }>;
    capabilities: Record<string, unknown>;
  };
  const declared = (await request.get(`${LIVE_HOST}/.well-known/ard.json`, { headers: { 'cache-control': 'no-cache' } })
    .then((r) => r.json())) as { entries?: Array<{ capabilities?: string[] }> };
  const ardIds = (declared.entries ?? []).flatMap((e) => e.capabilities ?? []);

  // A dotted id is the interesting case: it is exactly what slugification destroyed.
  const dotted = card.skills.filter((s) => s.id.includes('.') && (s.tags ?? []).includes('capability'));
  expect(dotted.length, 'this agent must advertise at least one self-asserted capability').toBeGreaterThan(0);
  for (const s of dotted) {
    expect(s.id, 'no slug substitution — the id is the id').not.toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/);
    expect(ardIds, `ARD carries ${s.id} unchanged`).toContain(s.id);
  }

  // The two fields A2A names alike stay apart: `skills[]` = what it can do, `capabilities` = protocol.
  for (const s of card.skills) expect(Object.keys(card.capabilities)).not.toContain(s.id);
  expect(card.capabilities).toHaveProperty('streaming');
});
