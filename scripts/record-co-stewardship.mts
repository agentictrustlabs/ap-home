/**
 * ADD A STEWARD TO AN ORGANIZATION — the organization's oversight wire to a SECOND person, approved by the
 * organization's custodian on chain, recorded in the new steward's own tree.
 *
 *   npx tsx scripts/record-co-stewardship.mts --org 0xC8Fd… --org-name missio-nexus.org \
 *     --custodian alice --steward carol [--deployment faithchain] [--days 365]
 *
 * The org-create ceremony mints ONE stewardship wire (org → its creator) and approves its digest inside the
 * org's genesis userOp. A co-steward is the same artifact for another person: `org → steward`, the Home's own
 * oversight caveats (`siteCaveats`: timestamp · value 0 · allowedTargets = `oversightMintTargets`), signed with
 * the approved-hash sentinel `0x03`. The approval is the organization's own act: `/harness/authorize` builds a
 * userOp FROM the org whose callData is `approveDigest(digest)` (generation 3+ — the account derives the key),
 * and only the org's custodian can sign it (the SA's validateUserOp). Approved-digest wires are what the
 * rotation ceremony re-approves under a new epoch (spec 410 §1), which is why this is not a key-signed wire.
 *
 * The steward then records it at their own Home (`/connect/related-orgs`, relationship steward). A link that
 * already reads `member` is sticky in the KV projection and the vault doc accumulates wires (the runtime reads
 * the FIRST), so a member link is retired from both first — steward ⊇ member.
 *
 * Idempotent: a steward link whose wire still verifies is left alone.
 */
import { hashDelegation, buildCaveat, encodeTimestampTerms, encodeValueTerms, encodeAllowedTargetsTerms, ROOT_AUTHORITY, type Delegation } from '@agenticprimitives/delegation';
import { getDeployments } from '@agenticprimitives/contracts/deployments';
import { createPublicClient, http, toHex, type Address, type Hex } from 'viem';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const HOME = (process.env.HOME_URL ?? 'https://www.faithnet.me').replace(/\/$/, '');
const A2A = (process.env.A2A_URL ?? 'https://a2a.faithnet.io').replace(/\/$/, '');
const DEPLOYMENT = arg('deployment') ?? 'faithchain';
const C = getDeployments(DEPLOYMENT as never) as unknown as Record<string, string> & { chainId: number };
const CHAIN = Number(C.chainId);
const ORG = (arg('org') ?? fail('--org <address> is required')).toLowerCase() as Address;
const ORG_NAME = arg('org-name') ?? '';
const CUSTODIAN = arg('custodian') ?? fail('--custodian <persona whose credential custodies the org> is required');
const STEWARD = arg('steward') ?? fail('--steward <persona> is required');
const DAYS = Number(arg('days') ?? 365);
if (!/^0x[0-9a-f]{40}$/.test(ORG)) fail('--org must be an address');

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const signin = async (handle: string) => {
  const w = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
  if (!w?.homeSession || !w?.agent) fail(`${handle} could not sign in at ${HOME}: ${JSON.stringify(w).slice(0, 200)}`);
  return { session: String(w.homeSession), sa: String(w.agent).toLowerCase() as Address };
};
const cust = await signin(CUSTODIAN);
const stew = await signin(STEWARD);
const sign = async (session: string, digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) fail(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`);
  return b.signature as Hex;
};
const pc = createPublicClient({ transport: http(process.env.RPC_URL ?? `${A2A}/rpc`) });
const ERC1271 = [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'h', type: 'bytes32' }, { name: 's', type: 'bytes' }], outputs: [{ type: 'bytes4' }] }] as const;
const approved = async (digest: Hex) => ((await pc.readContract({ address: ORG, abi: ERC1271, functionName: 'isValidSignature', args: [digest, '0x03'] }).catch(() => '0x')) as string) === '0x1626ba7e';

console.log(`${STEWARD} (${stew.sa}) becomes a steward of ${ORG_NAME || ORG} — approved by ${CUSTODIAN} (${cust.sa}) on eip155:${CHAIN}`);

// ── what the steward's Home holds today ──
const authS = { 'content-type': 'application/json', authorization: `Bearer ${stew.session}` };
const linksOf = async () => ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: authS }))).orgs ?? []) as Array<{ orgAgent: string; relationship?: string; stewardshipDelegation?: { signature?: string; caveats?: unknown[]; salt?: string; delegator?: string; delegate?: string; authority?: string } }>;
const before = (await linksOf()).find((o) => o.orgAgent.toLowerCase() === ORG);
if (before?.relationship === 'steward' && before.stewardshipDelegation?.signature === '0x03') {
  const w = before.stewardshipDelegation as unknown as Delegation & { salt: string };
  if (await approved(hashDelegation({ ...w, salt: BigInt(w.salt) } as Delegation, CHAIN, C.delegationManager as Address))) { console.log('· already a steward with an approved wire — nothing to do'); process.exit(0); }
}

// ── the wire: org → steward, the Home's oversight shape ──
const targets = [C.agentRelationship, C.agentNameRegistry, C.permissionlessSubregistry].filter((a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/i.test(a)) as Address[];
const validUntil = Math.floor(Date.now() / 1000) + DAYS * 86_400;
const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
const wire: Delegation = {
  delegator: ORG, delegate: stew.sa, authority: ROOT_AUTHORITY,
  caveats: [
    buildCaveat(C.timestampEnforcer as Address, encodeTimestampTerms(0, validUntil)),
    buildCaveat(C.valueEnforcer as Address, encodeValueTerms(0n)),
    buildCaveat(C.allowedTargetsEnforcer as Address, encodeAllowedTargetsTerms(targets)),
  ],
  salt, signature: '0x03',
};
const digest = hashDelegation(wire, CHAIN, C.delegationManager as Address);

// ── the organization approves it (its custodian signs the org's own userOp) ──
const csrfRes = await fetch(`${A2A}/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${A2A}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const a = await post('/harness/authorize', { session: cust.session, delegator: ORG, digests: [digest] });
if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
const b = await post('/harness/authorize', { session: cust.session, delegator: ORG, userOp: a.userOp, signature: await sign(cust.session, a.userOpHash as Hex) });
if (b.ok !== true) fail(`authorize submit: ${JSON.stringify(b).slice(0, 300)}`);
console.log(`  ${CUSTODIAN} approved the wire as the organization (tx ${String(b.txHash).slice(0, 18)}…)`);
let ok = false;
for (let i = 0; i < 10 && !ok; i++) { ok = await approved(digest); if (!ok) await new Promise((r) => setTimeout(r, 3000)); }
if (!ok) fail(`the organization's ERC-1271 does not accept the wire (digest ${digest}) — not recorded`);
console.log(`  on chain: ${ORG}.isValidSignature(digest, 0x03) = magic`);

// ── retire a member link first (KV projection + the authoritative vault doc) ──
if (before && before.relationship !== 'steward') {
  const rk = await j(await fetch(`${HOME}/connect/related-orgs`, { method: 'POST', headers: authS, body: JSON.stringify({ person: stew.sa, orgAgent: ORG, remove: true }) }));
  const rd = await j(await fetch(`${A2A}/interactions/${stew.sa}/relationships.merge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: stew.session, entry: { org: ORG }, remove: true }) }));
  console.log(`  retired the ${before.relationship} link: kv ${JSON.stringify(rk).slice(0, 80)} · doc ${JSON.stringify(rd).slice(0, 80)}`);
}

// ── the steward records it ──
const r = await j(await fetch(`${HOME}/connect/related-orgs`, { method: 'POST', headers: authS, body: JSON.stringify({
  person: stew.sa, orgAgent: ORG, orgName: ORG_NAME, purpose: 'organization', requestedBy: 'record-co-stewardship',
  kind: 'organization', parent: stew.sa, relationship: 'steward', stewardshipDelegation: { ...wire, salt: salt.toString() },
}) }));
console.log(`  recorded: ${JSON.stringify(r).slice(0, 160)}`);
const after = (await linksOf()).find((o) => o.orgAgent.toLowerCase() === ORG);
if (after?.relationship !== 'steward') fail(`${STEWARD}'s Home lists ${ORG} as ${after?.relationship ?? 'nothing'}`);
console.log(`✓ ${STEWARD}'s /connect/related-orgs: ${ORG_NAME || ORG} relationship=steward (wire sig ${after.stewardshipDelegation?.signature})`);
