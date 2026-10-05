/**
 * Spec 427 W3, LIVE in a browser: a person's Playbook page shows the ROLE an organization recorded for them with the
 * skill pack it offers; "Equip my agent" composes their playbook (base + pack) and writes it; the record carries
 * `composedFrom`; Remove takes the pack back out.
 *
 *   node scripts/walk-playbook-roles.mjs [handle=nathan] [--keep] [--headed]
 *
 * It needs a person who HOLDS a role that offers a pack: `scripts/verify-member-role.mts` sets one (Nathan is the
 * Coordinator of the game's organization). `--keep` leaves the pack equipped; otherwise the page's own Remove puts
 * the playbook back and the walk checks that it did. Screenshots land in OUT (default ./shots).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const OUT = process.env.OUT ?? 'shots';
const handle = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'nathan';
const KEEP = process.argv.includes('--keep');
mkdirSync(OUT, { recursive: true });
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`); if (!ok) failed += 1; };

const si = await (await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) })).json();
if (!si.homeSession) { console.error('demo-signin refused:', JSON.stringify(si).slice(0, 160)); process.exit(1); }
const me = String(si.agent).toLowerCase();
const record = async () => (await (await fetch(`${HOME}/connect/channels`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` }, body: JSON.stringify({ action: 'archetypeAssignmentGet', communityId: me }) })).json()).record ?? null;

const before = await record();
console.log(`${handle} ${me} — playbook ${before?.archetypeId ?? 'none'}, ${before?.definition?.tools?.length ?? 0} tools, packs ${JSON.stringify((before?.composedFrom?.packs ?? []).map((p) => p.archetype))}`);

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
await page.goto(`${HOME}/you#session=${si.homeSession}&via=Wallet`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.goto(`${HOME}/playbook`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});

const roles = page.locator('h4', { hasText: /^Roles$/ }).first();
await roles.waitFor({ timeout: 45000 }).catch(() => {});
check(await roles.count() > 0, 'the Playbook page has a Roles section');
// The assigned playbook prints every instruction it runs — tens of screens. The offer has to be above that.
const y = (await roles.boundingBox().catch(() => null))?.y ?? 99999;
check(y < 900, 'the Roles section is on the first screen, not under the playbook\'s full text', `y=${Math.round(y)}`);
// The read asks each organization in turn; wait for it to settle (an offer, an equipped pack, or the empty line).
await page.waitForFunction(() => !/Asking the organizations you belong to/.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {});
await page.screenshot({ path: `${OUT}/playbook-roles-1-before.png`, fullPage: false });
const text1 = await page.locator('body').innerText();

// If a pack is already equipped from an earlier walk, take it out first so the offer is what we test.
const removeBtn = page.getByRole('button', { name: /^Remove$/ }).first();
if (/Coordinator at /.test(text1) && await removeBtn.count()) {
  await removeBtn.click();
  await page.getByText(/Removed the .* pack/).waitFor({ timeout: 60000 }).catch(() => {});
  console.log('· an earlier walk left the pack equipped; removed it to start from the offer');
}

const offer = page.getByRole('button', { name: /Equip my agent/ }).first();
await offer.waitFor({ timeout: 30000 }).catch(() => {});
check(await offer.count() > 0, 'a role that offers a skill pack is OFFERED, with one button');
const offerText = await page.locator('body').innerText();
check(/Offered to you/.test(offerText) && /Coordinator/.test(offerText), 'the offer names the role', (offerText.match(/Coordinator[^\n]{0,80}/) ?? [''])[0]);
check(/field-operations\/role-coordinator/.test(offerText), 'the offer names the pack in the registry');
check(/adds /.test(offerText), 'the offer says what the pack adds', (offerText.match(/adds [^\n·]{0,120}/) ?? [''])[0]);
check(/grant no authority/i.test(offerText), 'the section says a role and its pack grant no authority');

await offer.click();
await page.getByText(/Equipped for Coordinator/).waitFor({ timeout: 90000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/playbook-roles-2-equipped.png`, fullPage: false });
const text2 = await page.locator('body').innerText();
check(/Equipped for Coordinator/.test(text2), 'pressing Equip says what was added', (text2.match(/Equipped for Coordinator[^\n]{0,160}/) ?? [''])[0]);
check(/with one role pack/.test(text2), 'the assigned playbook says it carries one role pack');
check(/you hold this role/.test(text2) || /Coordinator at /.test(text2), 'the pack is listed as equipped, against the role it came from');
check(/does not advertise what these roles add yet/.test(text2), 'the page says the public card does not advertise the pack yet');

const after = await record();
const cf = after?.composedFrom;
check(!!cf && cf.packs.length === 1 && cf.packs[0].archetype === 'role-coordinator', 'the record carries composedFrom with the pack', JSON.stringify(cf?.packs?.map((p) => ({ a: p.archetype, org: p.organization.slice(0, 8), role: p.roleName, as: p.equippedAs })) ?? null));
check(cf?.base?.archetype === 'person-steward', 'the base is kept by reference', `${cf?.base?.context}/${cf?.base?.archetype} ${String(cf?.base?.digest).slice(0, 12)}`);
check(cf?.packs?.[0]?.equippedAs === 'self' && cf?.packs?.[0]?.equippedBy === me, 'it records that the person equipped it themselves');
check((after?.definition?.tools?.length ?? 0) >= (before?.definition?.tools?.length ?? 0), 'the composed definition holds at least the base tools', `${before?.definition?.tools?.length ?? 0} → ${after?.definition?.tools?.length ?? 0}`);
const heading = ((after?.definition?.instructions ?? '').match(/## As Coordinator at[^\n]*/) ?? [''])[0];
check(!!heading, 'the pack\'s doctrine sits under its own heading in the instructions', heading);
check(!/0x[0-9a-f]{4}…/.test(heading), 'the heading names the organization in words, not by address', heading);

// A reload shows the same thing from the record (not from page state).
await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForFunction(() => !/Asking the organizations you belong to/.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {});
const text3 = await page.locator('body').innerText();
check(/Coordinator at /.test(text3) && !/Offered to you/.test(text3), 'after a reload the pack is equipped and no longer offered');
check(/you hold this role/.test(text3), 'the organization confirms the role is still held');

if (!KEEP) {
  await page.getByRole('button', { name: /^Remove$/ }).first().click();
  await page.getByText(/Removed the Coordinator pack/).waitFor({ timeout: 90000 }).catch(() => {});
  const gone = await record();
  check((gone?.composedFrom?.packs ?? []).length === 0, 'Remove takes the pack out of the record', `tools ${after?.definition?.tools?.length} → ${gone?.definition?.tools?.length}`);
  check(gone?.definitionDigest === gone?.composedFrom?.base?.digest || (gone?.definition?.tools?.length ?? 0) <= (after?.definition?.tools?.length ?? 0), 'the playbook is the base again');
  await page.waitForTimeout(1000);
  const text4 = await page.locator('body').innerText();
  check(/Offered to you/.test(text4), 'and the role\'s pack is offered again');
  await page.screenshot({ path: `${OUT}/playbook-roles-3-removed.png`, fullPage: false });
}
check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
