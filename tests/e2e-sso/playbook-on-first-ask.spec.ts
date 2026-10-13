/**
 * THE FIRST ASK OF A SESSION RUNS UNDER ITS PLAYBOOK — the 2026-10-13 incident, as a test.
 *
 * `ask-mv6jof27` ("number of unclaimed people groups in india") ran the BARE HARNESS: no playbook on the
 * trace, so no instruction skills to select among, 58 unnarrowed tools, and `kb.question` chosen over the
 * steward's own people-group skills — which answered an interpretation of the question instead of the
 * question. Every ask after it had its playbook.
 *
 * The cause was that four different things all rendered as `playbook: null`: no assignment, a digest that
 * does not match, a definition that no longer validates, and A READ THAT DID NOT HAPPEN. The runtime's
 * record port flattened a failed vault read to `null` (`callInteractionsInternal(...).catch(() => null)`),
 * the ask path remembered that null for a minute colo-wide with no invalidation path, and nothing said a
 * word — `loadPlaybook` logs a digest mismatch and an invalid definition, never a read that failed. A cold
 * refusal from the owner's InteractionsDO therefore made the agent bare for the next sixty seconds.
 * `prepare:playbook` answered in 8 ms, and a cold vault read is 1.9–3.0 s, which is how we know the read
 * never left the Worker.
 *
 * WHY THIS TEST IS WORTH ITS RUNTIME, when the unit tests already cover the reader: they cover it with a
 * stubbed port. Nothing in them would notice if the playbook stopped reaching the planner for a different
 * reason — a record the Home writes in a shape the runtime no longer accepts, an assignment pinned to a
 * definition a newer corpus rejects, an agent onboarded before the self-heal. All of those end as the same
 * sentence on the same line, and that line is the only place a person sees it.
 *
 * So this asserts the SENTENCE, not merely that a trace exists:
 *   · an archetype and a digest  ⇒ pass. The playbook reached the planner.
 *   · "none — its record could not be read (…)" ⇒ FAIL, and the reason is in the message. This is the
 *     incident recurring, and the point of the 2026-10-13 change is that it now says so out loud.
 *   · "none (bare harness)" ⇒ FAIL. Alice is a provisioned persona on a mode-0 Home: the estate's default
 *     is assigned at onboarding and healed once per session, so bare is not a state she has.
 */
import { test, expect } from '@playwright/test';

const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';

test('the first ask of a fresh session runs under a playbook, not the bare harness', async ({ page, request }) => {
  test.setTimeout(180_000);

  const signin = await request.post(`${HOME}/connect/demo-signin`, { data: { handle: 'alice', client_id: 'demo-web' } });
  expect(signin.ok(), 'alice signs in').toBeTruthy();
  const { homeSession } = (await signin.json()) as { homeSession: string };

  // A FRESH SESSION, and the ask is the FIRST thing it does — which is the condition under test. The
  // incident needed nothing more exotic than being first: the colo had no memory of this agent's
  // assignment yet, so the ask paid the cold read and inherited whatever it returned.
  await page.goto(`${HOME}/#session=${homeSession}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('ask-toggle')).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  await page.getByTestId('ask-toggle').click();
  // A read, deliberately: this test is about the plan's PROVENANCE, not about an act. Nothing here
  // should ever wait on a signature, so a question is the right shape.
  await page.getByTestId('ask-input').fill('what organizations am I part of');
  await page.getByTestId('ask-input').press('Enter');

  // STARTED, then SETTLED — never "enabled" alone, which passes in the milliseconds before the run has
  // disabled anything and reads a trace that does not exist yet (the lesson in `ask-diagnostics.spec.ts`).
  await expect(page.getByTestId('ask-input'), 'the run starts').toBeDisabled({ timeout: 30_000 });
  await expect(page.getByTestId('ask-input'), 'the run settles').toBeEnabled({ timeout: 120_000 });

  await page.getByTestId('ask-diagnostics-toggle').click();
  await expect(page.getByTestId('ask-diagnostics')).toBeVisible();

  const line = page.getByTestId('ask-trace-playbook').first();
  await expect(line, 'the trace names a playbook').toBeVisible({ timeout: 15_000 });
  const said = (await line.innerText()).trim();

  // The failure message carries what the screen said, because "expected visible" tells whoever reads the
  // CI log nothing about WHICH of the three states it hit — and the three have different fixes.
  expect(said, `the playbook record could not be READ — this is the 2026-10-13 incident recurring, not an unassigned agent. The runtime said: "${said}". Check the DO's own line (\`[334§6 vaultRead] archetype.assignment FAILED\`): needsEnable=true means storage is not enabled for this agent and a steward turns it on once; anything else is transient, and the reader now retries once and remembers no failure.`)
    .not.toMatch(/could not be read/i);
  expect(said, `the agent ran the BARE HARNESS: no playbook reached the planner, so the Ask offered the full unnarrowed tool set and none of the contracts a domain author wrote. Alice is a provisioned persona — the estate's default is assigned at onboarding and healed once per session by \`ensurePlaybook\` — so this means the assignment is missing, does not hash to its pinned digest, or no longer validates. The screen said: "${said}".`)
    .not.toMatch(/bare harness/i);

  // What a healthy line looks like: an archetype, a version, and the digest the definition hashes to.
  // Asserted positively as well, so a line that goes BLANK — or starts saying something new — fails here
  // rather than passing both negatives by saying nothing at all.
  expect(said, `the playbook line should name an archetype, a version and a digest; it said: "${said}"`)
    .toMatch(/\S+\s+v\S+\s+0x[0-9a-f]/i);
});
