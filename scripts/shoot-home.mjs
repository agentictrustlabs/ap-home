/**
 * Screenshots of the LIVE Home as a demo persona — the UX loop's eyes (Home UI system, 2026-09-12).
 *
 *   node scripts/shoot-home.mjs /work /messages /org/<sa>/members     → shots/<page>.png
 *   HOME_URL=https://home-rho-orpin.vercel.app HANDLE=mara W=400 node scripts/shoot-home.mjs /
 *
 * Signs in with `POST /connect/demo-signin` and plants the session via `/you#session=`. Headless Linux has no emoji
 * font: a tofu box in a shot is the environment, not the product. OUT= sets the directory (default ./shots).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const OUT = process.env.OUT ?? 'shots';
mkdirSync(OUT, { recursive: true });
const si = await (await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: process.env.HANDLE ?? 'alice', client_id: 'demo-web' }) })).json();
if (!si.homeSession) { console.error('demo-signin refused:', JSON.stringify(si).slice(0, 160)); process.exit(1); }
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: Number(process.env.W ?? 1360), height: Number(process.env.H ?? 900) } })).newPage();
await page.goto(`${HOME}/you#session=${si.homeSession}&via=Wallet`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2000);
for (const p of process.argv.slice(2)) {
  const name = p.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'home';
  await page.goto(`${HOME}${p}`, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 3000));
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: process.env.FULL === '1' });
  console.log('shot', p);
}
await browser.close();
