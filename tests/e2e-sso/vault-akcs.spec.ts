/**
 * Does a member's VAULT actually work — for someone who just signed up, and for a demo persona?
 *
 * This is the acceptance for per-person vault KEKs on AKCS (spec 278 on `agentic-kms`). It is written
 * against the product, not the KMS: what matters is whether a person can write something private and
 * read it back, because that is the only thing that proves wrap AND unwrap. Provisioning and binding
 * can both succeed while unwrap fails, and from the outside those look identical until someone opens
 * their records.
 *
 * Two users, deliberately, because they reach the KEK by different custody rails:
 *   · a NEW phone user — a KMS-custodied home, so every signature in the ceremony is made by the
 *     custody service itself. If the backend were misconfigured this user could not even be created.
 *   · alice — a demo persona whose custodian key the Home holds, signing like a wallet home would.
 * A regression that breaks one rail and not the other is exactly what one user alone would miss.
 *
 *   SSO_BASE_URL=https://www.faithnet.me npx playwright test -c tests/e2e-sso/playwright.config.ts vault-akcs
 */
import { test, expect, type Page } from '@playwright/test';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
const MCP = process.env.MCP_BASE_URL ?? 'https://mcp.faithnet.io';

/** A run-unique US number, so "new user" means NEW — a rerun that silently signed back in as the
 *  previous run's user would test the returning path while claiming to test signup. */
function freshPhone(): string {
  const n = String(Date.now()).slice(-7);
  return `+1303${n}`;
}

/** The signed-in person's SA, read the way the app reads it (session token → /me/profile). */
async function agentAddress(page: Page): Promise<string> {
  const sa = await page.evaluate(async () => {
    const raw = localStorage.getItem('agenticprimitives:demo-sso:session');
    if (!raw) return null;
    const { token } = JSON.parse(raw) as { token?: string };
    if (!token) return null;
    const r = await fetch('/me/profile', { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const b = (await r.json()) as { profile?: { agent?: string } };
    return b.profile?.agent?.split(':').pop() ?? null;
  });
  expect(sa, 'the signed-in person must have a Smart Agent address').toBeTruthy();
  return String(sa).toLowerCase();
}

/**
 * The vault half, identical for both users: the KEK is AKCS-backed and per-person, and a record
 * written through the product comes back through the product.
 */
async function assertVaultWorks(page: Page, request: import('@playwright/test').APIRequestContext, who: string): Promise<void> {
  const sa = await agentAddress(page);
  console.log(`[${who}] sa=${sa}`);

  // ── The key this person's data is wrapped under is THEIRS, and it is AKCS's. ────────────────────
  // A per-person ref is the whole of spec 278 VKB-D1: a shared tenant key separated only by AAD would
  // still read as "bound" here, so assert on the ref, not just on boundness.
  const info = (await (await request.get(`${MCP}/custody/vault-key/server-info?owner=${sa}`)).json()) as { kmsKeyRef?: string };
  expect(info.kmsKeyRef, 'the KEK ref must be an AKCS envelope purpose').toMatch(/^akcs:vault-kek:/);
  expect(info.kmsKeyRef, 'and it must name THIS person — not a tenant-wide key').toContain(sa);

  // POLL. Activation is fire-and-forget from the portal layout — the page renders, then the ceremony
  // runs — so a point-in-time read right after sign-in asks the question before the answer exists.
  // A generous window still fails honestly if it never binds; it just stops reporting a race as a bug.
  await expect
    .poll(async () => ((await (await request.get(`${MCP}/custody/vault-key/is-bound?owner=${sa}`)).json()) as { bound?: boolean }).bound,
      { timeout: 180_000, intervals: [5_000] })
    .toBe(true);
  const bound = (await (await request.get(`${MCP}/custody/vault-key/is-bound?owner=${sa}`)).json()) as { stale?: boolean };
  expect(bound.stale, 'the binding must be current — a stale one reads as bound but authorizes nothing').toBeFalsy();

  // ── WRITE, through the product. The capability record is private and vault-resident. ───────────
  const CAP_ID = 'adv:tax-position-analysis';
  await page.goto(`${HOME}/capabilities`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /what this agent can do/i })).toBeVisible({ timeout: 60_000 });

  // Wait for the EDITOR, not just the page heading. The editor renders only once the record has
  // loaded, so checking for the row before then finds nothing and reports "absent" for a capability
  // the agent already holds — then the picker offers "on this agent" instead of an Add button and the
  // run dies on a selector. Establish presence before asserting absence.
  const addToggle = page.getByRole('button', { name: /\+ Add a capability/i });
  await expect(addToggle, 'the capability editor must finish loading').toBeVisible({ timeout: 60_000 });

  const row = page.locator(`[data-capability="${CAP_ID}"]`);
  if (await row.count() === 0) {
    await addToggle.click();
    await page.getByLabel(/search capability definitions/i).fill(CAP_ID);
    await page.getByRole('button', { name: `add ${CAP_ID}` }).click();
    // Leave the picker open: adding flips this toggle's label to "Close", so clicking `addToggle`
    // again waits for a button that no longer exists under that name. The row renders above it anyway.
  }
  await expect(row, 'the capability must be on the agent before we save').toBeVisible({ timeout: 20_000 });

  // Make a REAL edit, run-unique, so this proves a fresh write rather than passing on what a previous
  // run left behind — and so autosave has something to do. Waiting for "Saved" without changing
  // anything would wait forever, and be right to: nothing changed, so nothing was saved.
  const marker = `vault check ${Date.now().toString(36).slice(-5)}`;
  await row.getByLabel(/example queries for/i).fill(marker);

  // The private record AUTOSAVES — there is no Save button, because the vault write carries no consent
  // and a button implies a decision. Wait for the status line rather than pressing something.
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 60_000 });

  // ── READ IT BACK, from the vault, on a fresh page load. ────────────────────────────────────────
  // /records reads the VAULT (not the Home's KV mirror), so a value appearing here has been through
  // wrap and unwrap. Enable interactions first if this brand-new member has never issued that grant —
  // that is a real onboarding step, not a workaround.
  await page.goto(`${HOME}/records`, { waitUntil: 'domcontentloaded' });

  // Wait for the reader to reach a VERDICT before reading it. Checking for the "Enable interactions"
  // gate the instant the page loads finds nothing — the reader is still fetching — so the run skips
  // the step and then fails looking for records the gate was standing in front of the whole time.
  const settled = page.getByRole('button', { name: /Enable interactions/i })
    .or(page.getByText(/vault key isn.t active yet/i))
    .or(page.getByText(/No records yet/i))
    .or(page.getByText(/Couldn.t read/i))
    .or(page.locator('li:has(code)'));
  await expect(settled.first(), 'the records reader must reach a verdict').toBeVisible({ timeout: 120_000 });

  // Enabling interactions is a real onboarding step for a brand-new member (it signs one grant), not
  // a workaround — a member who has never issued it has no plane holding their records.
  const enable = page.getByRole('button', { name: /Enable interactions/i });
  if (await enable.count()) {
    await enable.click();
    await expect(enable, 'enabling interactions must complete').toHaveCount(0, { timeout: 180_000 });
  }

  // The vault-key gate must NOT be what we are looking at: that message means the KEK never activated.
  await expect(page.getByText(/vault key isn.t active yet/i), 'the vault key must be active').toHaveCount(0);

  // `capabilities.data` is the record's CURRENT key; `skills.data` is the same record under its
  // pre-ADR-0051 name, which an unmigrated owner may still be on.
  const record = page.locator('li', { hasText: 'capabilities.data' }).or(page.locator('li', { hasText: 'skills.data' })).first();
  await expect(record, 'the capability record must be IN the vault').toBeVisible({ timeout: 120_000 });
  await record.getByRole('button', { name: /^show$/ }).click();
  // The decrypted body — the actual proof of unwrap. An error string here is a decrypt failure.
  const body = record.locator('pre');
  await expect(body).toBeVisible({ timeout: 60_000 });
  await expect(body, 'the record must DECRYPT, not error').not.toContainText(/\(error:/);
  await expect(body, 'and carry the capability that was just written').toContainText(CAP_ID, { timeout: 60_000 });
  await expect(body, "and THIS run's edit, not a previous run's").toContainText(marker, { timeout: 60_000 });
}

test('a brand-new phone member gets a working vault', async ({ page, request }) => {
  test.setTimeout(600_000);
  const phone = freshPhone();

  // Twilio is unconfigured on this deployment, so `/connect/phone/start` echoes the code it generated.
  // Read it off the RESPONSE rather than calling the API separately, so the run drives the real flow.
  let code: string | null = null;
  page.on('response', async (res) => {
    if (!res.url().includes('/connect/phone/start')) return;
    const b = (await res.json().catch(() => ({}))) as { devCode?: string };
    if (b.devCode) code = b.devCode;
  });

  await page.goto(`${HOME}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Continue with phone/i }).first().click();
  await page.getByLabel(/Phone number/i).fill(phone);
  await page.getByTestId('phone-auth-continue').click();

  await expect.poll(() => code, { timeout: 60_000, intervals: [1_000] }).toBeTruthy();
  console.log(`[phone] ${phone} → code received`);
  // Fill the code field ONLY once the card has actually switched to the code step; the Verify button
  // is disabled until six digits are in it, so a fill that lands early leaves the click waiting on a
  // button that will never enable — which reads as "the flow is broken" when it is just a race.
  const codeField = page.getByTestId('phone-auth-code');
  await expect(codeField).toBeVisible({ timeout: 60_000 });
  await codeField.fill(code!);
  await expect(codeField).toHaveValue(code!);
  // The card AUTO-SUBMITS on the sixth digit, so there is deliberately nothing to click here. Clicking
  // Verify anyway waits on a button that went busy-then-gone doing the very thing we asked for, which
  // times out and reads as "sign-in is broken" when sign-in is already underway.

  // A new phone member's home is DEPLOYED for them (KMS-custodied) — that is the slow part.
  await expect
    .poll(async () => page.evaluate(() => !!localStorage.getItem('agenticprimitives:demo-sso:session')), { timeout: 300_000, intervals: [3_000] })
    .toBe(true);

  await assertVaultWorks(page, request, `phone ${phone}`);
});

test('alice — an existing demo persona — has a working vault', async ({ page, request }) => {
  test.setTimeout(600_000);

  const signin = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'alice', client_id: 'demo-jp' } });
  expect(signin.ok(), `demo-signin ${signin.status()}`).toBe(true);
  const { homeSession } = (await signin.json()) as { homeSession?: string };
  expect(homeSession, 'demo-signin must mint a Home session for alice').toBeTruthy();

  await page.goto(`${HOME}/records#session=${homeSession}`, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(async () => page.evaluate(() => !!localStorage.getItem('agenticprimitives:demo-sso:session')), { timeout: 120_000, intervals: [2_000] })
    .toBe(true);

  await assertVaultWorks(page, request, 'alice');
});
