/**
 * Spec 397 W4 — REVOKE AT THE HOME, live (no model; one on-chain revocation).
 *
 *   npx tsx scripts/verify-home-mcp-revoke.mts
 *
 * alice connects Claude (a fresh ask-as-me wire) and Claude asks once. Her Home lists the connection under Connected
 * assistants (/connect/app-grants) with the wire. She revokes it: the wire is disabled on chain from her own account
 * (what the panel's Revoke does). THE TWIN: Claude's next ask is refused at HER AGENT'S gate in its words, and the
 * Home MCP says she must authorize again; the bearer alone is worth nothing. Then the row is gone from her Home.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createPublicClient, http, encodeFunctionData, type Address, type Hex } from 'viem';
import { hashDelegation, type Delegation } from '../packages/delegation/src/index.ts';
const MCP = process.env.HOME_MCP_URL ?? 'https://home-mcp-faithnet.richardpedersen3.workers.dev';
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const RPC = process.env.RPC_URL ?? 'https://a2a.faithnet.io/rpc';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${MCP}${path}`, { method: 'POST', headers: { 'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// ── connect + one ask ──
const reg = await j(await post('/oauth/register', { client_name: 'verify-home-mcp-revoke', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }));
const verifier = b64u(randomBytes(48));
const conn = await j(await post('/oauth/demo-connect', { handle: 'alice', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64u(createHash('sha256').update(verifier).digest()), resource: `${MCP}/mcp` }));
if (!conn.code) fail(`demo-connect: ${JSON.stringify(conn)}`);
const tok = await j(await post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: conn.code, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier, resource: `${MCP}/mcp` }).toString()));
if (!tok.access_token) fail(`token: ${JSON.stringify(tok)}`);
const call = async (name: string, args: Record<string, unknown>) => { const r = await j(await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { authorization: `Bearer ${tok.access_token}` })); return { out: (r.result?.structuredContent ?? {}) as Record<string, unknown>, isError: !!r.result?.isError }; };
const before = await call('my_runs', { limit: 1 });
console.log(`connected · my_runs → ${before.isError ? `error ${before.out.error}` : `${((before.out.runs ?? []) as unknown[]).length} run(s)`}`);
if (before.isError) fail('the connection does not work before the revoke');

// ── her Home: the row, and the revoke on chain from her own account ──
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const auth = { authorization: `Bearer ${si.homeSession}` };
const grants = await j(await fetch(`${HOME}/connect/app-grants`, { headers: auth }));
const row = ((grants.grants ?? []) as Array<{ clientId: string; appName: string; delegation: Delegation & { salt: string }; validUntil: number | null }>).find((g) => g.clientId === 'home-mcp');
console.log(`Connected assistants → ${JSON.stringify(((grants.grants ?? []) as Array<{ clientId: string; appName: string }>).map((g) => `${g.appName} (${g.clientId})`))}`);
if (!row) fail('her Home lists no Home MCP connection');
const wire = { ...row.delegation, salt: BigInt(row.delegation.salt) } as Delegation;
const digest = hashDelegation(wire, CHAIN, DM);
const REVOKE_ABI = [{ type: 'function', name: 'revokeDelegationByOwner', stateMutability: 'nonpayable', inputs: [{ name: 'delegation', type: 'tuple', components: [{ name: 'delegator', type: 'address' }, { name: 'delegate', type: 'address' }, { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }, { name: 'salt', type: 'uint256' }, { name: 'signature', type: 'bytes' }] }], outputs: [] }] as const;
const EXECUTE_ABI = [{ type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] }] as const;
const inner = encodeFunctionData({ abi: REVOKE_ABI, functionName: 'revokeDelegationByOwner', args: [{ delegator: wire.delegator, delegate: wire.delegate, authority: wire.authority, caveats: wire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })), salt: wire.salt, signature: wire.signature }] });
const callData = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [DM, 0n, inner] });
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '', ...auth };
const sign = async (d: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ digest: d }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 200)}`); return b.signature; };
let txHash: string | undefined;
for (let attempt = 0; attempt < 3 && !txHash; attempt++) {
  const b = await j(await fetch(`${HOME}/a2a/account/build-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ sender: wire.delegator, callData, session: si.homeSession }) }));
  if (!b.ok || !b.userOpHash) { console.log(`  build → ${JSON.stringify(b).slice(0, 200)}`); await new Promise((r) => setTimeout(r, 2000)); continue; }
  const signature = await sign(b.userOpHash);
  const s = await j(await fetch(`${HOME}/a2a/account/submit-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ userOp: { ...b.userOp, signature }, session: si.homeSession }) }));
  if (s.ok) txHash = s.transactionHash; else console.log(`  submit → ${JSON.stringify(s).slice(0, 200)}`);
}
if (!txHash) fail('the revocation could not be submitted from her account');
console.log(`revoked on chain · tx ${txHash.slice(0, 14)}…`);
const pub = createPublicClient({ transport: http(RPC) });
let revoked = false;
for (let i = 0; i < 10 && !revoked; i++) { await new Promise((r) => setTimeout(r, 1500)); revoked = (await pub.readContract({ address: DM, abi: [{ type: 'function', name: 'isRevoked', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] }], functionName: 'isRevoked', args: [digest] })) as boolean; }
console.log(`  isRevoked(${digest.slice(0, 12)}…) = ${revoked}`);
if (!revoked) fail('the chain still honours the wire');
await fetch(`${HOME}/connect/app-grants`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ clientId: 'home-mcp', revoked: true }) });

// ── TWIN: Claude's next ask ──
const after = await call('ask', { message: 'who is in Missio Nexus?', plan: { steps: [{ toolId: 'organization.membership.list', args: { org: 'missio nexus' } }] } });
console.log(`twin · ask after the revoke → ${after.isError ? `refused: ${String(after.out.error).slice(0, 140)}` : `ANSWERED ${after.out.kind}`}`);
if (!after.isError || after.out.reauthorize !== true) fail('a revoked wire must be refused at her agent and reported as needing re-authorization');
const rows = await j(await fetch(`${HOME}/connect/app-grants`, { headers: auth }));
if (((rows.grants ?? []) as Array<{ clientId: string }>).some((g) => g.clientId === 'home-mcp')) fail('the row is still listed after the revoke');
console.log('\n✓ spec 397 W4: revoked at her Home, refused at her agent in its words; the bearer alone is worth nothing');
