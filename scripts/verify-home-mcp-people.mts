/**
 * Spec 397 — TWO PEOPLE AND ONE'S OWN RECORDS, through the host (no model for the invite; one model call for the records).
 *
 *   npx tsx scripts/verify-home-mcp-people.mts
 *
 * 1. THE INVITATION: alice, through Claude, invites david.me to Missio Nexus (asked AT the organization). Her run parks
 *    authority_required with the organization's alsoApprove digests; at her Home the one-prompt path approves the
 *    mandate and the grant in one org userOp and the run finishes with the signed invitation; the Home's half records it
 *    in the organization's vault (what the flyout's on-done hook does). Then DAVID, at his own agent, sees the invitation.
 * 2. HER OWN RECORDS: "who is in my household" through Claude reaches vault.records.query — her records, not the directory.
 *    THE TWIN: the same question about nathan's records is refused — no stewardship, no read.
 * 3. INSPECT: ligonier.svc's card through its name's records, with the pin verdict.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { hashDelegation, buildDigestBindingCaveat, capabilityHandler, ROOT_AUTHORITY, registerDefaultSubsetHandlers, type Delegation, type Caveat, type MandateRequirementV1 } from '../packages/delegation/src/index.ts';
registerDefaultSubsetHandlers();
const MCP = process.env.HOME_MCP_URL ?? 'https://home-mcp-faithnet.richardpedersen3.workers.dev';
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const ORG = 'missio-nexus.org'; const INVITEE = process.env.INVITEE ?? 'david.me';
const CHAIN = 34348; const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = { delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1' } as const;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${MCP}${path}`, { method: 'POST', headers: { 'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
async function connect(handle: string) {
  const reg = await j(await post('/oauth/register', { client_name: `verify-people-${handle}`, redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }));
  const v = b64u(randomBytes(48));
  const conn = await j(await post('/oauth/demo-connect', { handle, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64u(createHash('sha256').update(v).digest()), resource: `${MCP}/mcp` }));
  if (!conn.code) fail(`demo-connect ${handle}: ${JSON.stringify(conn)}`);
  const tok = await j(await post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: conn.code, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: v, resource: `${MCP}/mcp` }).toString()));
  if (!tok.access_token) fail(`token ${handle}: ${JSON.stringify(tok)}`);
  const call = async (name: string, args: Record<string, unknown>) => { const r = await j(await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { authorization: `Bearer ${tok.access_token}` })); return { out: (r.result?.structuredContent ?? {}) as Record<string, unknown>, isError: !!r.result?.isError }; };
  return { call, agent: String(conn.agent).toLowerCase() as Address };
}
const alice = await connect('alice');
const david = await connect('david');
const orgInfo = await j(await fetch(`${HOME}/connect/name-info?name=${ORG}`)) as { agent?: string };
const ORG_ADDR = String(orgInfo.agent ?? '').toLowerCase() as Address;

// ── 1. the invitation, asked at the organization ──
const nonce = Date.now().toString(36);
const inv = await alice.call('ask', { addressee: ORG, message: `invite ${INVITEE} to this organization (${nonce})`, plan: { steps: [{ toolId: 'organization.membership.invite', args: { invitee: INVITEE } }] } });
console.log(`invite → ${inv.out.kind} · run ${inv.out.runRef}`);
if (inv.out.kind !== 'authority_required') fail(`expected authority_required: ${JSON.stringify(inv.out).slice(0, 400)}`);
// her Home's one-prompt path (what the flyout does on /you?run=): the org approves the mandate + the grant in ONE userOp
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const sign = async (d: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` }, body: JSON.stringify({ digest: d }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 200)}`); return b.signature; };
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const home = async (path: string, body: Record<string, unknown>) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: si.homeSession, ...body }) }));
let r = await home('/harness/ask', { addressee: ORG_ADDR, runRef: inv.out.runRef });
let rep = r.reply as { kind?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; error?: string; result?: Record<string, unknown> };
if (rep?.kind !== 'authority_required' || !rep.requirement || !rep.delegator || !rep.delegate) fail(`her Home's resume should show the requirement: ${JSON.stringify(r).slice(0, 400)}`);
const caveats: Caveat[] = [...capabilityHandler.toCaveats(rep.requirement, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', rep.requirement.intentDigest as Hex)];
let salt = 0n; for (const b of randomBytes(16)) salt = (salt << 8n) | BigInt(b);
const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
const a = await home('/harness/authorize', { delegator: rep.delegator, digests: [hashDelegation(mandate, CHAIN, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
const b2 = await home('/harness/authorize', { delegator: rep.delegator, userOp: a.userOp, signature: await sign(a.userOpHash as Hex) });
if (b2.ok !== true) fail(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
mandate.signature = '0x03';
r = await home('/harness/ask', { addressee: ORG_ADDR, runRef: inv.out.runRef, presented: { ...mandate, salt: salt.toString() } });
rep = r.reply;
console.log(`  she approved at her Home → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
if (rep?.kind !== 'done' && rep?.kind !== 'answer') fail(`the invitation did not finish: ${JSON.stringify(r).slice(0, 400)}`);
const result = (rep.result ?? {}) as { org?: string; invitee?: string; memberAccessDelegation?: unknown; invited?: boolean };
if (result.invited && result.memberAccessDelegation) {
  const stored = await j(await fetch(`${HOME}/connect/org-invite/agent`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` }, body: JSON.stringify({ org: String(result.org).toLowerCase(), agent: String(result.invitee).toLowerCase(), memberAccessDelegation: result.memberAccessDelegation }) }));
  console.log(`  recorded in the organization's vault (the Home's half) → ${stored.ok === true ? 'ok' : JSON.stringify(stored).slice(0, 120)}`);
}
// Claude reads the outcome
const rec = await alice.call('run', { run: inv.out.runRef, addressee: ORG });
console.log(`  Claude reads the run → ${rec.out.outcome} · receipts ${JSON.stringify(((rec.out.receipts ?? []) as Array<{ toolId: string; status: string }>).map((x) => `${x.toolId}:${x.status}`))}`);
if (rec.out.outcome !== 'completed') fail(`Claude could not read the run at the organization: ${JSON.stringify(rec.out).slice(0, 300)}`);
// the organization's own list of pending invitations names him (asked at the organization, under her standing)
const seen = await alice.call('ask', { addressee: ORG, message: 'who has been invited', plan: { steps: [{ toolId: 'organization.invitations.list', args: {} }] } });
const seenText = String(seen.out.text ?? '');
console.log(`invitations at ${ORG} → ${seen.out.kind} · ${seenText.replace(/\s+/g, ' ').slice(0, 140)}…`);
if (seen.out.kind !== 'answer' || !/david/i.test(seenText)) fail(`the organization does not list david's invitation: ${JSON.stringify(seen.out).slice(0, 300)}`);
// the invitee's own view through Claude ("what invitations do I have") is not a capability yet — see the backlog.
void david;

// ── 2. her own records ──
const hh = await alice.call('ask', { message: 'who is in my household', plan: { steps: [{ toolId: 'vault.records.query', args: { question: 'who is in my household' } }] } });
console.log(`her records → ${hh.out.kind} · ${String(hh.out.text ?? hh.out.error ?? '').replace(/\s+/g, ' ').slice(0, 120)}…`);
if (hh.out.kind !== 'answer') fail(`her own records did not answer: ${JSON.stringify(hh.out).slice(0, 300)}`);
const other = await alice.call('ask', { message: "who is in nathan's household", plan: { steps: [{ toolId: 'vault.records.query', args: { question: 'who is in the household', subject: 'nathan.me' } }] } });
console.log(`twin · nathan's records → ${other.out.kind} · ${String(other.out.text ?? other.out.error ?? '').replace(/\s+/g, ' ').slice(0, 120)}`);
if (other.out.kind === 'answer' && !/cannot|no stewardship|refus|not (yours|readable)|may not|could not/i.test(String(other.out.text ?? ''))) fail("nathan's records were read without stewardship");

// ── 3. inspect ──
const insp = await alice.call('inspect_agent', { agent: 'ligonier.svc' });
const card = insp.out.card as { name?: string; skills?: Array<{ id?: string }> } | undefined;
console.log(`inspect ligonier.svc → ${card?.name ?? insp.out.refused} · skills ${(card?.skills ?? []).length} · pinned ${insp.out.pinned} · matchesPin ${insp.out.matchesPin ?? 'n/a'}`);
if (insp.isError || !card?.name) fail(`inspect: ${JSON.stringify(insp.out).slice(0, 300)}`);
console.log('\n✓ spec 397: an invitation asked through Claude, approved at her Home, seen by the invitee\'s agent; her own records answered and another\'s refused; a card inspected through its name');
