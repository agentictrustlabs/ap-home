/**
 * Spec 397 §6 — THE /you?run= PAGE IN A REAL BROWSER (local; needs a Playwright chromium): a payment parked through the Home
 * MCP, the grant link opened as alice, the Ask shows the requirement and "Grant & continue". Not on the nightly ledger
 * (the runner has no browser); run it after any change to the flyout, the shell or the page.
 *
 *   npx tsx scripts/verify-home-mcp-you-page.mts
 */
// A REAL BROWSER on /you?run=: park a payment through the Home MCP, then open the link as alice and expect the Ask to show
// the requirement with "Grant & continue". Screenshot to the scratchpad.
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from '@playwright/test';
const MCP = 'https://home-mcp-faithnet.richardpedersen3.workers.dev';
const HOME = 'https://www.faithnet.me';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300) }; } };
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const post = (p: string, b: unknown, h: Record<string, string> = {}) => fetch(`${MCP}${p}`, { method: 'POST', headers: { 'content-type': typeof b === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', ...h }, body: typeof b === 'string' ? b : JSON.stringify(b) });
const reg = await j(await post('/oauth/register', { client_name: 'you-page-check', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }));
const v = b64u(randomBytes(48));
const conn = await j(await post('/oauth/demo-connect', { handle: 'alice', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64u(createHash('sha256').update(v).digest()), resource: `${MCP}/mcp` }));
const tok = await j(await post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: conn.code, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: v, resource: `${MCP}/mcp` }).toString()));
const r = await j(await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { message: `pay nathan.treasury 1 usdc (you page ${Date.now().toString(36)})`, plan: { steps: [{ toolId: 'treasury.payment.execute', args: { payee: 'nathan.treasury', usdc: '1' }, id: 's0' }] } } } }, { authorization: `Bearer ${tok.access_token}` }));
const out = r.result?.structuredContent ?? {};
console.log('parked', out.kind, out.runRef);
if (out.kind !== 'authority_required') { console.log(JSON.stringify(out).slice(0, 300)); process.exit(1); }
const link = await j(await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'grant_link', arguments: { run: out.runRef } } }, { authorization: `Bearer ${tok.access_token}` }));
const url = String(link.result?.structuredContent?.url);
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 160)); });
await page.goto(`${url}#session=${si.homeSession}`, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForSelector('[data-testid="ask-grant"]', { timeout: 90_000 });
  const text = await page.locator('.ask-flyout, [data-testid="ask-flyout"], body').first().innerText();
  console.log('flyout shows Grant & continue ·', /1 USDC|usdc|nathan/i.test(text) ? 'names the payment' : 'payment words not seen');
  await page.screenshot({ path: './you-page.png' });
  console.log('✓ /you?run= opened the parked run in a real browser');
} catch (e) {
  await page.screenshot({ path: './you-page-fail.png' });
  console.log('✗', e instanceof Error ? e.message.slice(0, 200) : String(e), '· url', page.url());
  console.log((await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400));
} finally { await browser.close(); }
