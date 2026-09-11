/**
 * Spec 397 — THE BROWSER PATH, replayed headlessly: exactly what the Home's recognized-enroll screen does for a demo
 * person who picked themselves from the "Demo people" fold when Claude sent them to the Home.
 *
 *   npx tsx scripts/verify-home-mcp-browser-path.mts
 *
 * 1. an MCP client starts /oauth/authorize at the Home MCP → a redirect to the Home's connect with client_id=home-mcp,
 *    delegation_template=ask-as-me and the Home MCP's own PKCE + state;
 * 2. alice signs in (demo-signin — the fold's seam) and the SPA's enroll runs: /oidc/authorize-grant (the registered
 *    delegate comes back), her ask-as-me wire to that delegate signed through /connect/persona-sign (the prompt-free
 *    demo-custody signature), /oidc/grant → the Home's code;
 * 3. the Home MCP's /oauth/callback exchanges it at the Home's /token, verifies the id_token and the wire, and sends the
 *    client its own code, which becomes a bearer that lists tools. No secret, no browser, the same three servers.
 */
import { createHash, randomBytes } from 'node:crypto';
import { keccak256, toBytes, type Hex, type Address } from 'viem';
import { buildCaveat, encodeTimestampTerms, encodeAllowedMethodsTerms, hashDelegation, ROOT_AUTHORITY, type Delegation } from '@agenticprimitives/delegation';
const MCP = process.env.HOME_MCP_URL ?? 'https://home-mcp-faithnet.richardpedersen3.workers.dev';
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const CHAIN_ID = 34348;
const C = { delegationManager: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestampEnforcer: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedMethodsEnforcer: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41' } as const;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// 1 — the client starts at the Home MCP
const reg = await j(await fetch(`${MCP}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'verify-browser-path', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) }));
const verifier = b64u(randomBytes(48));
const q = new URLSearchParams({ client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', response_type: 'code', code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: `${MCP}/mcp`, scope: 'ask', state: 'client-state-1' });
const start = await fetch(`${MCP}/oauth/authorize?${q}`, { redirect: 'manual' });
const toHome = start.headers.get('location') ?? '';
console.log(`authorize → ${start.status} → ${toHome.slice(0, 90)}…`);
if (start.status !== 302 || !toHome.startsWith(HOME)) fail(`the Home MCP did not send the person to the Home: ${start.status} ${toHome.slice(0, 200)}`);
const hq = new URL(toHome).searchParams;
if (hq.get('client_id') !== 'home-mcp' || hq.get('delegation_template') !== 'ask-as-me' || !hq.get('code_challenge') || !hq.get('state')) fail(`the Home request lacks a field: ${toHome}`);

// 2 — alice on the Home: the fold's sign-in, then the SPA's recognized enroll
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
if (!si.homeSession) fail(`demo-signin: ${JSON.stringify(si).slice(0, 200)}`);
const alice = String(si.agent) as Address;
const spa = { 'content-type': 'application/json', origin: HOME };
const ag = await j(await fetch(`${HOME}/oidc/authorize-grant`, { method: 'POST', headers: spa, body: JSON.stringify({ client_id: hq.get('client_id'), redirect_uri: hq.get('redirect_uri'), agent_name: si.agent_name ?? 'alice.me', delegation_template: hq.get('delegation_template'), code_challenge: hq.get('code_challenge'), code_challenge_method: 'S256', nonce: hq.get('nonce') ?? '' }) }));
if (!ag.grant_id) fail(`authorize-grant: ${JSON.stringify(ag).slice(0, 200)}`);
console.log(`authorize-grant → delegate ${ag.delegate}`);
const validUntil = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
let salt = 0n; for (const b of randomBytes(16)) salt = (salt << 8n) | BigInt(b);
const d: Delegation = { delegator: alice, delegate: ag.delegate as Address, authority: ROOT_AUTHORITY, salt, signature: '0x', caveats: [
  buildCaveat(C.timestampEnforcer as Address, encodeTimestampTerms(0, validUntil)),
  buildCaveat(C.allowedMethodsEnforcer as Address, encodeAllowedMethodsTerms([keccak256(toBytes('harness.ask')).slice(0, 10) as Hex])),
] };
const digest = hashDelegation(d, CHAIN_ID, C.delegationManager as Address);
const ps = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` }, body: JSON.stringify({ digest }) }));
if (!ps.signature) fail(`persona-sign: ${JSON.stringify(ps).slice(0, 200)}`);
d.signature = ps.signature;
const gr = await j(await fetch(`${HOME}/oidc/grant`, { method: 'POST', headers: spa, body: JSON.stringify({ grant_id: ag.grant_id, delegation: { ...d, salt: d.salt.toString() } }) }));
if (!gr.code) fail(`grant: ${JSON.stringify(gr).slice(0, 300)}`);
console.log(`grant → the Home's code (ask-as-me wire accepted, signed prompt-free for a demo person)`);

// 3 — back at the Home MCP: the callback exchanges, verifies, and answers the client
const cb = await fetch(`${MCP}/oauth/callback?code=${encodeURIComponent(gr.code)}&state=${encodeURIComponent(hq.get('state')!)}`, { redirect: 'manual' });
const toClient = cb.headers.get('location') ?? '';
console.log(`callback → ${cb.status} → ${toClient.slice(0, 80)}…`);
if (cb.status !== 302 || !toClient.startsWith('https://claude.ai/api/mcp/auth_callback')) fail(`callback: ${cb.status} ${(await cb.text()).slice(0, 300)}`);
const cq = new URL(toClient).searchParams;
if (cq.get('state') !== 'client-state-1' || !cq.get('code')) fail('the client got no code with its state');
const tok = await j(await fetch(`${MCP}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: cq.get('code')!, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier, resource: `${MCP}/mcp` }).toString() }));
if (!tok.access_token) fail(`token: ${JSON.stringify(tok)}`);
const list = await j(await fetch(`${MCP}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }));
console.log(`bearer → tools ${JSON.stringify((list.result?.tools ?? []).map((t: { name: string }) => t.name))}`);
if (!(list.result?.tools ?? []).length) fail('no tools for the browser-path bearer');
console.log('\n✓ spec 397: the browser path — Claude → Home MCP → the Home\'s connect (ask-as-me) → callback → bearer — holds for a demo person');
