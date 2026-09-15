/**
 * Spec 402 W4 — AN APP INSIDE THE ASK, in a real browser (needs a Playwright chromium).
 *
 *   npx tsx scripts/verify-ask-app.mts        (from the repo root)
 *
 * The steward asks her own agent, in the Home's Ask flyout, "what do you remember about me". Three layers must agree
 * for the memory app to render: the CONTRACT names `interaction.result: MemoryFactsCard` (registry → person-steward →
 * her pinned playbook), the HARNESS carries the binding and the step's rows on the answer, and the HOME's registry
 * renders the name over them. A supplied plan keeps the model out of it; the assertion is the rendered app with the
 * fact she just told her agent. Twin: with no memory app in the reply the sentence stands alone (a read with no result
 * component renders no app).
 */
import { chromium } from '@playwright/test';
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME } from './fixture.mts';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const fail = (m: string): never => { console.error(`✗ ${m}`); process.exit(1); };
const steward = await personaCustodian(HOME, fx.people.steward);
const me = steward.agent.toLowerCase();
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const nonce = Date.now().toString(36);
const FACT = `I sing in the choir (gate ${nonce})`;
console.log(`── ${fx.people.steward} asks her agent in the Ask; the memory app must render ──`);

// the fact, kept as her (a supplied plan — no model)
const kept = await post('/harness/ask', { session: steward.bearer, addressee: me, message: `remember that ${FACT}`, plan: { steps: [{ toolId: 'person.memory.remember', args: { fact: FACT } }] } });
const id = ((kept.reply?.result ?? {}) as { id?: string }).id;
if (!id) fail(`remember: ${JSON.stringify(kept).slice(0, 200)}`);

// the reply carries the binding and the rows (the harness half)
const raw = await post('/harness/ask', { session: steward.bearer, addressee: me, message: 'what do you remember about me', plan: { steps: [{ toolId: 'person.memory.list', args: {} }] } });
if (raw.reply?.interaction?.result !== 'MemoryFactsCard' || !(raw.reply?.results ?? []).some((x: { toolId: string }) => x.toolId === 'person.memory.list')) fail(`the reply carries no memory app binding: ${JSON.stringify(raw.reply?.interaction)} · results ${JSON.stringify((raw.reply?.results ?? []).map((x: { toolId: string }) => x.toolId))}`);
console.log('  the reply names MemoryFactsCard over person.memory.list ✓');

// the Home renders it (the app's half)
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: fx.people.steward, client_id: 'demo-web' }) }));
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  await page.goto(`${HOME}/you#session=${si.homeSession}&via=Wallet`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.goto(`${HOME}/`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.locator('.portal-ask-btn').first().click();
  const input = page.locator('[data-testid="ask-input"]').first();
  await input.fill('what do you remember about me');
  await page.keyboard.press('Enter');
  const app = page.locator('[data-testid="ask-app"]').first();
  await app.waitFor({ timeout: 60000 }).catch(() => fail('no app rendered in the Ask within 60s'));
  const text = await app.innerText();
  if (!text.includes('I sing in the choir')) fail(`the app rendered but not over her fact: "${text.slice(0, 200)}"`);
  console.log('  the memory app rendered in the Ask, with her fact ✓');
  // twin — a read with no result component renders no app: the roster of her organization (organization.membership.list names none)
  await input.fill('who are the members of missio nexus');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(20000);
  const apps = await page.locator('[data-testid="ask-app"]').count();
  if (apps !== 1) fail(`twin: ${apps} apps after a read whose contract names no result component (expected the one from before)`);
  console.log('  twin: a read with no result component renders no app ✓');
} finally {
  await browser.close();
  await post('/harness/ask', { session: steward.bearer, addressee: me, message: 'forget that', plan: { steps: [{ toolId: 'person.memory.forget', args: { id } }] } });
}
console.log('✓ verify-ask-app — the contract, the harness and the Home agree: the capability\'s own app rendered inside the reply');
