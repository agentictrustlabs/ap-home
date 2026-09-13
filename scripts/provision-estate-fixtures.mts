/**
 * PROVISION A DEPLOYMENT'S GATE FIXTURE — the roles scripts/fixture.mts names, chartered the way a person would.
 *
 *   FIXTURE_JSON=scripts/split/ap-home-fixture.json npx tsx scripts/provision-estate-fixtures.mts [--dry-run]
 *
 * For the estate the live gates run against (spec 399 §5.5 — seven green nights), the fixture file names WHO plays
 * each role and this script makes it true, idempotently, through each person's OWN Ask with plans supplied:
 *   1. the steward charters `org` and `peerOrg` (`organization.create`, parent = the steward's own agent);
 *   2. the steward charters `treasuries.own` / `ownOther`, the payee owner charters `treasuries.payee`
 *      (`treasury.create`, parent = the person);
 *   2b. for each agent chartered, the STEWARD LINK the Home's own ceremony would have written (its `related:`
 *      projection + `relationships.data`): a stewardship wire agent → person, signed by the agent's custodian — the
 *      artifact record-service-stewardship.mts writes for a scripted charter; without it every steward-gated call
 *      at the agent (invite, assign a playbook) refuses;
 *   2c. the agent's VAULT KEY (spec 278) — the Home's ceremony binds it; a scripted charter does not, and without it
 *      the organization's vault refuses every write (`vault_key_unauthorized`). Bound here as provision-all-demo-planes
 *      does: the custodian's proof, the Home's KMS ref, the authorization signed by the owner's custodian;
 *   2d. the steward's two treasuries hold demo USDC (`treasury.fund` — the faucet mint, in the funder's name): a
 *      parked payment must reach its mandate, and a payer holding 0 is refused before it parks;
 *   2e. `routineAgent` carries its playbook (the coordinator's, which declares schedule rows) — the assignment record
 *      the Playbook page writes, put under the steward's session + stewardship wire;
 *   3. the steward invites `member` and `member2` to `org` on the one-prompt path (the mandate and the org→member
 *      grant approved in ONE userOp, the Home's half recorded), and each member JOINS — signs the member→org access
 *      delegation and records the membership, as the join card does.
 * Every mandate is signed by the person's own demo custodian through the Home's persona-sign; nothing is minted by a
 * script key (the same argument charter-ligonier.mts and provision-all-demo-planes.mts make). A name that already
 * resolves is kept; a link, a key, a membership already there is kept — run it again after anything fails. (The
 * interactions + delivery planes come with the charter itself; provision-all-demo-planes.mts confirms them.)
 *
 * What it does NOT do, said: `specialist` (a runtime service with a playbook that hands payments to it), `ministry`
 * (a content-catalog agent in the public registry) and `team` stay null until an operator charters them — the gates
 * that need them skip by name.
 */
import { randomBytes } from 'node:crypto';
import { createPublicClient, erc20Abi, formatUnits, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { buildCaveat, buildDigestBindingCaveat, capabilityHandler, encodeAllowedTargetsTerms, encodeTimestampTerms, encodeValueTerms, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { fixture as fx, HOME, A2A } from './fixture.mts';

const DRY = process.argv.includes('--dry-run');
// The chain's contracts, from the published package (`CHAIN_NAME` picks the deployment; faithchain is both estates').
const CHAIN_NAME = process.env.CHAIN_NAME ?? 'faithchain';
const C = ((await import(`@agenticprimitives/contracts/deployments/${CHAIN_NAME}`)) as { CONTRACTS: Record<string, string> & { chainId: number } }).CONTRACTS;
const CHAIN = Number(C.chainId);
const DM = C.delegationManager as Address;
const ENFORCERS = { delegationManager: DM, timestamp: C.timestampEnforcer, allowedTargets: C.allowedTargetsEnforcer, allowedMethods: C.allowedMethodsEnforcer, value: C.valueEnforcer, payment: C.paymentEnforcer, digestBinding: C.digestBindingEnforcer } as const;
// The Home's own delegation helpers read the chain from the environment at import — set before the import.
process.env.NEXT_PUBLIC_CHAIN_ID = String(CHAIN);
process.env.NEXT_PUBLIC_CONTRACTS_JSON = JSON.stringify(C);
process.env.NEXT_PUBLIC_VAULT_SERVER_ID = fx.vaultServerId;
const { buildVaultKeyAuthorization, issueMemberProfileAccessDelegation, toWire } = await import('../apps/demo-sso-next/src/lib/delegation');

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Persona = { handle: string; sa: string; custodian?: string };
const personas = (((await j(await fetch(`${HOME}/connect/demo-personas`))) as { personas?: Persona[] }).personas ?? []);
const custodianOf = (handle: string): Address => { const p = personas.find((x) => x.handle === handle); if (!p?.custodian) fail(`${handle} is not a demo persona at ${HOME} (or has no custodian)`); return p!.custodian!.toLowerCase() as Address; };

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));

interface Session { handle: string; token: string; me: Address; custodian: Address; sign: (d: Hex) => Promise<Hex> }
async function signIn(handle: string): Promise<Session> {
  const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
  if (!si.homeSession) fail(`${handle} could not sign in at ${HOME}: ${JSON.stringify(si).slice(0, 160)}`);
  const token = String(si.homeSession);
  const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign (${handle}): ${JSON.stringify(b).slice(0, 160)}`); return b.signature as Hex; };
  return { handle, token, me: String(si.agent).toLowerCase() as Address, custodian: custodianOf(handle), sign };
}
const nameInfo = async (name: string): Promise<Address | null> => { const r = await j(await fetch(`${HOME}/connect/name-info?name=${encodeURIComponent(name)}`)) as { exists?: boolean; agent?: string; deployed?: boolean }; return r.exists && r.agent && r.deployed !== false ? (r.agent.toLowerCase() as Address) : null; };
const relatedOrgs = async (s: Session) => (((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${s.token}` } }))).orgs ?? []) as Array<{ orgAgent: string; orgName?: string; relationship?: string; kind?: string; stewardshipDelegation?: unknown }>);

type Reply = { kind?: string; error?: string; text?: string; runRef?: string; resumeToken?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; prompt?: { kind?: string; digest?: Hex; prompt?: string; stepRef?: string; fields?: unknown; signer?: string; payload?: unknown }; result?: unknown };

/** One act through a person's agent (addressed at `addressee`): the plan supplied, the mandate they sign on the
 *  one-prompt path (mandate + any grant digest in ONE userOp), the custodian and signature prompts answered. */
async function act(s: Session, addressee: Address, message: string, toolId: string, args: Record<string, unknown>): Promise<Reply> {
  if (DRY) { console.log(`  [dry-run] ${s.handle} @ ${addressee.slice(0, 10)}…: ${toolId} ${JSON.stringify(args)}`); return { kind: 'done' }; }
  let r = await post('/harness/ask', { session: s.token, addressee, message, plan: { steps: [{ toolId, args }] } });
  let rep = r.reply as Reply | undefined;
  console.log(`  ask → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
  for (let round = 0; round < 6; round++) {
    if (rep?.kind === 'authority_required' && rep.requirement && rep.delegator && rep.delegate) {
      const req = rep.requirement;
      const caveats: Caveat[] = [...capabilityHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding as Address, 'intent', req.intentDigest as Hex)];
      let salt = 0n; for (const b of randomBytes(16)) salt = (salt << 8n) | BigInt(b);
      const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
      const a = await post('/harness/authorize', { session: s.token, delegator: rep.delegator, digests: [hashDelegation(mandate, CHAIN, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
      if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
      const b2 = await post('/harness/authorize', { session: s.token, delegator: rep.delegator, userOp: a.userOp, signature: await s.sign(a.userOpHash as Hex) });
      if (b2.ok !== true) fail(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
      mandate.signature = '0x03';
      console.log(`  ${s.handle} signed the mandate (tx ${String(b2.txHash).slice(0, 18)}…)`);
      r = await post('/harness/ask', { session: s.token, addressee, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
      rep = r.reply as Reply | undefined;
      console.log(`  resume → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.prompt?.prompt ? ` "${rep.prompt.prompt.slice(0, 100)}"` : ''}`);
      continue;
    }
    if (rep?.kind === 'prompt' && rep.prompt?.kind === 'data' && Array.isArray(rep.prompt.fields)) {
      const fields = rep.prompt.fields as Array<{ name: string; type?: string }>;
      const cred = fields.find((f) => f.type === 'credential');
      if (!cred || fields.length !== 1) fail(`the act asks for data a script cannot answer: ${JSON.stringify(fields).slice(0, 300)}`);
      r = await post('/harness/ask', { session: s.token, addressee, runRef: rep.runRef, supplied: [{ stepRef: rep.resumeToken ?? rep.prompt.stepRef, data: { [cred!.name]: { kind: 'eoa', address: s.custodian } } }] });
      rep = r.reply as Reply | undefined;
      console.log(`  custodian supplied → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
      continue;
    }
    if (rep?.kind === 'prompt' && rep.prompt?.kind === 'signature' && rep.prompt.digest) {
      const p = rep.prompt;
      r = await post('/harness/ask', { session: s.token, addressee, runRef: rep.runRef, supplied: [{ stepRef: rep.resumeToken ?? p.stepRef, signature: { digest: p.digest, signer: p.signer ?? s.custodian, signature: await s.sign(p.digest as Hex), ...(p.payload !== undefined ? { payload: p.payload } : {}) } }] });
      rep = r.reply as Reply | undefined;
      console.log(`  signed → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
      continue;
    }
    break;
  }
  if (rep?.kind !== 'done' && rep?.kind !== 'answer') fail(`${toolId} did not finish: ${JSON.stringify(r).slice(0, 700)}`);
  return rep!;
}

/** Charter `<label>.<tld>` under `parent` as `s`, unless it already resolves. */
async function charter(s: Session, name: string, toolId: string, noun: string, parent: Address): Promise<Address | null> {
  const [label, tld] = name.split('.') as [string, string];
  const have = await nameInfo(name);
  if (have) { console.log(`${name} already resolves → ${have}`); return have; }
  console.log(`── ${name}: ${s.handle} charters the ${noun} under ${parent.slice(0, 10)}… ──`);
  await act(s, s.me, `create ${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun} called ${label}`, toolId, { parent, label });
  if (DRY) return null;
  let sa: Address | null = null;
  for (let i = 0; i < 12 && !sa; i++) { await sleep(4000); sa = await nameInfo(name); }
  if (!sa) fail(`${name} does not resolve after the charter`);
  console.log(`  ${name} → ${sa} (.${tld})`);
  return sa;
}

/** The steward link for an agent `s` custodies — the Home's own artifact (record-service-stewardship.mts), re-verified
 *  on chain by the Home and the DO on every use. Kept when already there. */
async function recordStewardLink(s: Session, sa: Address, name: string, kind: 'org' | 'team' | 'person-treasury', parent: Address): Promise<void> {
  const links = await relatedOrgs(s);
  if (links.some((o) => o.orgAgent.toLowerCase() === sa && o.relationship === 'steward')) { console.log(`  ${name}: steward link already there`); return; }
  if (DRY) { console.log(`  [dry-run] would record ${s.handle}'s steward link for ${name}`); return; }
  const validUntil = Math.floor(Date.now() / 1000) + 3650 * 86_400;
  const targets = [C.agentRelationship, C.agentNameRegistry, C.permissionlessSubregistry] as Address[];
  let salt = 0n; for (const b of randomBytes(16)) salt = (salt << 8n) | BigInt(b);
  const d: Delegation = {
    delegator: sa, delegate: s.me, authority: ROOT_AUTHORITY,
    caveats: [
      buildCaveat(C.timestampEnforcer as Address, encodeTimestampTerms(0, validUntil)),
      buildCaveat(C.valueEnforcer as Address, encodeValueTerms(0n)),
      buildCaveat(C.allowedTargetsEnforcer as Address, encodeAllowedTargetsTerms(targets)),
    ],
    salt, signature: '0x',
  };
  d.signature = await s.sign(hashDelegation(d, CHAIN, DM));
  const r = await j(await fetch(`${HOME}/connect/related-orgs`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}` }, body: JSON.stringify({
    person: s.me, orgAgent: sa, orgName: name, purpose: kind === 'person-treasury' ? 'treasury' : 'organization', requestedBy: 'provision-estate-fixtures',
    kind, parent, relationship: 'steward', stewardshipDelegation: { ...d, salt: salt.toString() },
  }) }));
  const ok = r.ok === true || r.link || r.orgAgent;
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${s.handle}'s steward link${ok ? '' : ` — ${JSON.stringify(r).slice(0, 200)}`}`);
  if (!ok) fail(`the steward link for ${name} was not recorded`);
}

/** The agent's vault key (spec 278) — provision-all-demo-planes' third leg, for an agent `s` custodies. */
async function bindVaultKey(s: Session, sa: Address, name: string): Promise<void> {
  const kb = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/is-bound?owner=${sa}`)) as { bound?: boolean; allowedResources?: string[] };
  if (kb.bound === true && (kb.allowedResources ?? []).includes('vault:*')) { console.log(`  ${name}: vault key already bound`); return; }
  if (DRY) { console.log(`  [dry-run] would bind ${name}'s vault key`); return; }
  const info = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/server-info`)) as { serverId?: string; serverKey?: string; defaultResources?: string[]; classificationCeiling?: string; ops?: ('read' | 'write')[] };
  const issuedAt = Math.floor(Date.now() / 1000);
  const challenge = keccak256(toBytes(['demo-mcp:vault-key-provision:v1', sa, String(issuedAt)].join('\n')));
  const prov = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/provision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: sa, issuedAt, proof: await s.sign(challenge) }) })) as { ok?: boolean; kmsKeyRef?: string; error_description?: string; detail?: string };
  if (!prov.ok || !prov.kmsKeyRef) fail(`${name}: vault key provision — ${prov.error_description ?? prov.detail ?? 'failed'}`);
  const params = { vaultId: String(info.serverId ?? '').trim() || fx.vaultServerId, kmsKeyRef: prov.kmsKeyRef!, serverKey: (info.serverKey ?? '0x0000000000000000000000000000000000000001') as Address, allowedResources: info.defaultResources ?? ['person-pii', 'org-sensitive', 'profile', 'vault:*'], classificationCeiling: info.classificationCeiling ?? 'regulated.high', ops: info.ops ?? ['read', 'write'] as ('read' | 'write')[] };
  const { delegation, digest, expiresAt } = buildVaultKeyAuthorization(sa, params);
  delegation.signature = await s.sign(digest);
  const bound = await j(await fetch(`${HOME}/mcp-bind/custody/vault-key/bind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: sa, vaultId: params.vaultId, kmsKeyRef: params.kmsKeyRef, allowedResources: params.allowedResources, classificationCeiling: params.classificationCeiling, ops: params.ops, expiresAt, authorization: toWire(delegation) }) })) as { ok?: boolean; reason?: string; error?: string };
  if (bound.ok !== true) fail(`${name}: vault key bind — ${bound.reason ?? bound.error ?? 'failed'}`);
  console.log(`  ✓ ${name}: vault key bound (${params.kmsKeyRef.slice(0, 24)}…)`);
}

const steward = await signIn(fx.people.steward);
console.log(`estate ${HOME} · chain ${CHAIN} · steward ${fx.people.steward} ${steward.me}`);

// 1. the organizations
const orgSa = await charter(steward, fx.org.handle, 'organization.create', 'organization', steward.me);
if (orgSa) { await recordStewardLink(steward, orgSa, fx.org.handle, 'org', steward.me); await bindVaultKey(steward, orgSa, fx.org.handle); }
if (fx.peerOrg) { const peer = await charter(steward, fx.peerOrg.handle, 'organization.create', 'organization', steward.me); if (peer) { await recordStewardLink(steward, peer, fx.peerOrg.handle, 'org', steward.me); await bindVaultKey(steward, peer, fx.peerOrg.handle); } }

// 1b. two teams under the organization whose names share a word — so the word names two agents, neither the room
for (const team of [fx.team, fx.team2]) if (team && orgSa) { const sa = await charter(steward, team.handle, 'organization.team.create', 'team', orgSa); if (sa) { await recordStewardLink(steward, sa, team.handle, 'team', orgSa); await bindVaultKey(steward, sa, team.handle); } }

// 2. the treasuries — the steward's own two, and the payee's
for (const t of [fx.treasuries.own, fx.treasuries.ownOther]) { const sa = await charter(steward, t, 'treasury.create', 'treasury', steward.me); if (sa) { await recordStewardLink(steward, sa, t, 'person-treasury', steward.me); await bindVaultKey(steward, sa, t); } }
const payeeOwner = await signIn(fx.people.payeeOwner);
{ const sa = await charter(payeeOwner, fx.treasuries.payee, 'treasury.create', 'treasury', payeeOwner.me); if (sa) { await recordStewardLink(payeeOwner, sa, fx.treasuries.payee, 'person-treasury', payeeOwner.me); await bindVaultKey(payeeOwner, sa, fx.treasuries.payee); } }

// 2d. the steward's treasuries hold demo USDC — a payment gate's payer must be able to pay
const FUND_USDC = process.env.FUND_USDC ?? '100';
const chain = createPublicClient({ transport: http(`${A2A}/rpc`) });
for (const t of [fx.treasuries.own, fx.treasuries.ownOther]) {
  const sa = await nameInfo(t);
  if (!sa) continue;
  const held = await chain.readContract({ address: C.mockUsdc as Address, abi: erc20Abi, functionName: 'balanceOf', args: [sa] }).catch(() => 0n);
  const usdc = Number(formatUnits(held, 6));
  if (usdc >= 10) { console.log(`${t} holds ${usdc} USDC`); continue; }
  console.log(`── ${t} holds ${usdc} USDC: ${fx.people.steward} funds it with ${FUND_USDC} demo USDC ──`);
  await act(steward, steward.me, `fund ${t} with ${FUND_USDC} usdc`, 'treasury.fund', { funder: steward.me, asset: C.mockUsdc, treasury: t, usdc: FUND_USDC });
}

// 2e. the routine agent's playbook — the assignment the Home's Playbook page writes (K3), here from the registry by digest
if (fx.routineAgent) {
  const sa = await nameInfo(fx.routineAgent.handle);
  if (!sa) console.log(`${fx.routineAgent.handle} does not resolve — charter it (a team under the organization) and run again`);
  else {
    const links = await relatedOrgs(steward);
    const wire = links.find((o) => o.orgAgent.toLowerCase() === sa)?.stewardshipDelegation;
    const got = await j(await fetch(`${A2A}/interactions/${sa}/channels.archetypeAssignment.get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: steward.token, ...(wire ? { stewardship: wire } : {}) }) })) as { record?: { archetypeId?: string; definitionDigest?: string } };
    const want = `skill:archetypes/${fx.routineAgent.playbook.split('/').pop()}`;
    if (got.record?.archetypeId === want) console.log(`${fx.routineAgent.handle}: playbook ${got.record.archetypeId} already assigned (${String(got.record.definitionDigest).slice(0, 12)}…)`);
    else if (DRY) console.log(`  [dry-run] would assign ${fx.routineAgent.playbook} to ${fx.routineAgent.handle}`);
    else {
      const r = await fetch(`${fx.skillsRegistry.replace(/\/$/, '')}/context/contexts/${fx.routineAgent.playbook.replace('/', '/archetypes/')}/definition`, { headers: { 'user-agent': 'Mozilla/5.0 (provision-estate-fixtures)' } });
      const b = (await r.json().catch(() => ({}))) as { definition?: { archetypeId: string; archetypeVersion: string }; digest?: string };
      if (!b.definition || !b.digest) fail(`the ${fx.routineAgent.playbook} definition could not be read from ${fx.skillsRegistry}`);
      const record = { type: 'ap.archetype-assignment.v1', archetypeId: b.definition!.archetypeId, archetypeVersion: b.definition!.archetypeVersion, definitionDigest: b.digest, definition: b.definition };
      const put = await j(await fetch(`${A2A}/interactions/${sa}/channels.archetypeAssignment.put`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: steward.token, ...(wire ? { stewardship: wire } : {}), record }) }));
      console.log(`  ${put.ok === true || put.record ? '✓' : '✗'} ${fx.routineAgent.handle}: ${b.definition!.archetypeId} v${b.definition!.archetypeVersion} assigned${put.ok === true || put.record ? '' : ` — ${JSON.stringify(put).slice(0, 200)}`}`);
      if (!(put.ok === true || put.record)) fail(`the playbook was not assigned to ${fx.routineAgent.handle}`);
    }
  }
}

// 3. the members — invited by the steward at the organization, joined by themselves. Two halves, each kept when
// already there: the ORGANIZATION's (the org→member access grant, which its roster reads) and the MEMBER's (the
// member→org access delegation, which their own links read).
const roster = async (): Promise<string> => { if (!orgSa || DRY) return ''; const r = await act(steward, orgSa, 'who are the members', 'organization.membership.list', { org: orgSa }); return String(r.text ?? '').toLowerCase(); };
let members = await roster();
for (const handle of [fx.people.member, fx.people.member2]) {
  const m = await signIn(handle);
  const related = (await relatedOrgs(m)).some((o) => orgSa && o.orgAgent.toLowerCase() === orgSa);
  const listed = members.includes(handle) || members.includes(m.me);
  // the organization's OWN record of the membership (ap.org.membership.v1 in its vault) — what its serving plane reads
  const atDo = orgSa ? ((await j(await fetch(`${A2A}/interactions/${orgSa}/endeavor.list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: m.token }) }))) as { member?: boolean }).member === true : false;
  if (related && listed && atDo) { console.log(`${handle} is a member of ${fx.org.handle} on both halves`); continue; }
  if (!orgSa) { console.log(`  [dry-run] would invite ${handle} to ${fx.org.handle} and join`); continue; }
  console.log(`── ${handle}.me at ${fx.org.handle}: organization's half ${listed ? 'there' : 'missing'} · member's half ${related ? 'there' : 'missing'} · the organization's membership record ${atDo ? 'there' : 'missing'} ──`);
  let mad: { delegator?: string; delegate?: string; signature?: string } | undefined;
  if (!listed) {
    const inv = await act(steward, orgSa, `invite ${handle}.me to this organization`, 'organization.membership.invite', { invitee: `${handle}.me` });
    const result = (inv.result ?? {}) as { org?: string; invitee?: string; memberAccessDelegation?: typeof mad; invited?: boolean };
    mad = result.memberAccessDelegation;
    if (result.invited && mad) {
      const stored = await j(await fetch(`${HOME}/connect/org-invite/agent`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${steward.token}` }, body: JSON.stringify({ org: String(result.org).toLowerCase(), agent: String(result.invitee).toLowerCase(), memberAccessDelegation: mad }) }));
      console.log(`  the organization's half recorded → ${stored.ok === true ? 'ok' : JSON.stringify(stored).slice(0, 160)}`);
      if (stored.ok !== true) fail(`the organization's half of ${handle}'s membership was not recorded`);
    } else fail(`the invitation carried no member-access grant: ${JSON.stringify(result).slice(0, 200)}`);
  }
  if (!related || !atDo) {
    const d = await issueMemberProfileAccessDelegation(m.me, orgSa, fx.vaultServerId, m.sign);
    const joined = await j(await fetch(`${HOME}/connect/org-membership`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${m.token}` }, body: JSON.stringify({ org: orgSa, delegation: toWire(d), ...(mad ? { memberAccessDelegation: mad } : {}), displayName: handle }) })) as { ok?: boolean; membershipRecorded?: boolean; membershipError?: string };
    console.log(`  ${handle} joined → ${joined.ok === true ? 'ok' : JSON.stringify(joined).slice(0, 200)} · the organization's record ${joined.membershipRecorded ? 'written' : `NOT written${joined.membershipError ? `: ${joined.membershipError}` : ''}`}`);
    if (joined.ok !== true || !joined.membershipRecorded) fail(`${handle} could not join ${fx.org.handle} with the organization's own record`);
  }
}
members = await roster();
console.log(`  the roster now: ${members.replace(/\s+/g, ' ').slice(0, 200)}`);

console.log(`\n✓ the fixture stands at ${HOME}: ${fx.org.handle}${fx.peerOrg ? ` · ${fx.peerOrg.handle}` : ''} · ${fx.treasuries.own} · ${fx.treasuries.ownOther} · ${fx.treasuries.payee} · members ${fx.people.member}, ${fx.people.member2}.`);
