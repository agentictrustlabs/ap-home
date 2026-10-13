/**
 * ALICE ASKS HER AGENTS TO DO WHAT THE BUTTONS DO.
 *
 * The Ask's promise (spec 350 §3.7) is that anything a person can do by walking the UX they can do by
 * saying it — in the realm they are standing in, with the authority that realm needs. This drives the real
 * flyout in a real browser, one realm at a time, and asserts the thing that is easy to fake and impossible
 * to fake usefully: that an ACTION ask does not come back as a paragraph.
 *
 * The failure this exists to catch is not a crash. It is the Ask cheerfully answering — "here is the
 * address you asked about, no funding was performed" — which reads like help and leaves nothing done. So
 * every action case asserts an authority request or a prompt appeared, and never the answer bubble alone.
 *
 * Alice is a seeded demo person: the Home holds her custodian key, so signatures are prompt-free and a
 * ceremony can run to completion in CI without a wallet.
 */
import { test, expect, type Page } from '@playwright/test';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
const SUFFIX = Date.now().toString(36).slice(-5);

/** Sign in as alice and land in a realm. `path` is the workspace the Ask will be addressed to. */
async function asAlice(page: Page, request: import('@playwright/test').APIRequestContext, path = '/'): Promise<void> {
  const signin = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'alice', client_id: 'demo-jp' } });
  expect(signin.ok(), 'demo-signin').toBeTruthy();
  const { homeSession } = (await signin.json()) as { homeSession: string };
  await page.goto(`${HOME}${path}#session=${homeSession}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('ask-toggle')).toBeVisible({ timeout: 30_000 });
  // The session fragment is consumed and the shell re-renders under whatever is open — a flyout opened
  // during that window is unmounted mid-request, which reads as "the agent never answered". Let the home
  // settle before asking it anything.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(2_000);
}

/** Type an ask and wait for the agent to come back with something. Returns what KIND of reply appeared. */
async function ask(page: Page, message: string, timeout = 120_000): Promise<'authority' | 'prompt' | 'answer' | 'none'> {
  const flyout = page.getByTestId('ask-flyout');
  if (!(await flyout.isVisible().catch(() => false))) await page.getByTestId('ask-toggle').click();
  await expect(flyout).toBeVisible();
  await page.getByTestId('ask-input').fill(message);
  await page.getByTestId('ask-input').press('Enter');
  const authority = page.getByTestId('ask-authority');
  const prompt = page.getByTestId('ask-prompt');
  const agentSaid = flyout.locator('.ask-msg.agent:not([data-testid])').last();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await authority.isVisible().catch(() => false)) return 'authority';
    if (await prompt.isVisible().catch(() => false)) return 'prompt';
    // The thread shows a placeholder for a reply whose content lives in a card — treat only real prose
    // as an answer, or every authority request reads as one.
    const text = ((await agentSaid.textContent().catch(() => '')) ?? '').trim();
    if (text && text !== '…' && !text.includes(message) && !SURFACE_SAID.test(text)) return 'answer';
    await page.waitForTimeout(1_000);
  }
  return 'none';
}

/** The surface's OWN status lines. They are not the agent answering, and reading them as an answer is how
 *  "Authority granted: create organizations, for this request." became a failed assertion. */
const SURFACE_SAID = /^(authority granted|the invitation is stored|.* is in your agents now)/i;

/** Grant the authority the agent asked for, and wait for the next thing it says. */
async function grant(page: Page): Promise<'prompt' | 'done' | 'answer' | 'none'> {
  await page.getByTestId('ask-grant').click();
  const prompt = page.getByTestId('ask-prompt');
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await prompt.isVisible().catch(() => false)) return 'prompt';
    const said = ((await page.getByTestId('ask-flyout').locator('.ask-msg.agent:not([data-testid])').last().textContent().catch(() => '')) ?? '').trim();
    if (/is live|already exists|is in your agents/i.test(said)) return 'done';
    if (said.length > 40 && !SURFACE_SAID.test(said)) return 'answer';
    await page.waitForTimeout(1_500);
  }
  return 'none';
}

test.describe('the Ask does what the buttons do', () => {
  // An ask is a model call, a chain read and sometimes a userOp. The default 30s is a timeout on the
  // TEST, not on the agent, and hitting it says nothing about whether the Ask works.
  test.setTimeout(300_000);

  test('standing in her own realm, alice can charter an organization — end to end', async ({ page, request }) => {
    await asAlice(page, request, '/');
    expect(await ask(page, `create an organization called e2e-org-${SUFFIX}`)).toBe('authority');
    // The grant names what is being granted, as words, before anything is signed.
    await expect(page.getByTestId('ask-authority')).toContainText(/create organizations/i);
    expect(await grant(page)).not.toBe('answer'); // it must ACT, not narrate
  });

  test('an action ask is never answered with a paragraph', async ({ page, request }) => {
    await asAlice(page, request, '/');
    for (const message of [
      `create a team called e2e-team-${SUFFIX}`,
      `create a treasury for me`,
    ]) {
      const kind = await ask(page, message);
      expect(kind, `"${message}" must ask for authority or for input, not answer`).not.toBe('answer');
      expect(kind, `"${message}" got no reply`).not.toBe('none');
      // Dismiss whatever it asked for and move on to the next sentence.
      const notNow = page.getByRole('button', { name: /not now|cancel/i }).first();
      if (await notNow.isVisible().catch(() => false)) await notNow.click();
    }
  });

  test('a question is answered from evidence, and an unknown is admitted', async ({ page, request }) => {
    await asAlice(page, request, '/');
    expect(await ask(page, 'what kinds of agents exist here?')).toBe('answer');
    // Composed prose arrives in pieces; give the assertion room rather than racing the first line.
    await expect(page.getByTestId('ask-flyout')).toContainText(/team|organization|person/i, { timeout: 30_000 });
    expect(await ask(page, 'how many kangaroo sanctuaries are registered here?')).toBe('answer');
    await expect(page.getByTestId('ask-flyout').locator('.ask-msg.agent:not([data-testid])').last())
      .toContainText(/does not list|not list|no .*kangaroo|nothing/i, { timeout: 30_000 });
  });

  test('the Ask says when this credential cannot authorize the realm it is standing in', async ({ page, request }) => {
    // Northern Colorado Field sits in alice's tree but is custodied by another persona's credential.
    await asAlice(page, request, '/org/0x3d653cbab0c99b1513439758eb2eac2039caa6e1/members');
    await page.getByTestId('ask-toggle').click();
    await expect(page.getByTestId('ask-flyout')).toContainText(/different credential custodies this agent/i, { timeout: 30_000 });
  });
});
