/**
 * GIVE AN EXISTING WORKSPACE ITS GOVERNING ORGANIZATION — the owner's rule, 2026-10-02 (`org.ttl` §2, `core.ttl`;
 * `src/lib/workspace-governor.ts`).
 *
 *   npx tsx apps/home/scripts/workspace-governor.mts <custodian-handle> <workspace-sa> [--dry]
 *
 * A `<label>.workspace` agent is a SERVICE that coordinates a workspace and holds no members; membership belongs
 * to the organization that governs it. Every club and field workspace chartered before today was chartered alone,
 * and wrote its `org.membership:member:<sa>` records on itself. This script, run AS THE CUSTODIAN (a demo person
 * whose key the Home holds — `demo-signin` for the session, `/connect/persona-sign` for every signature), does
 * for one workspace what `workspace-create` now does for a new one:
 *
 *   1. charters `<label>.org` through the custodian's own Ask (`organization.create` — the same door
 *      `charter-cast.mts` uses for `person.create`: the mandate they sign, the credential they supply, the
 *      genesis they sign), then records it the way the Home's own ceremony does — the steward link, the founder's
 *      OrganizationMembership, the steward relationship;
 *   2. writes the PAIR: `workspace:<ws>` (aporg:Workspace) in the organization's vault, `workspace.governor` in
 *      the workspace's;
 *   3. re-parents the custodian's link to the workspace under the organization and stamps `governor` on it;
 *   4. MOVES THE MEMBERSHIP: for each `org.membership:member:<sa>` the workspace holds, the organization invites
 *      that member (the org→member access grant, the role word, its signed half of the has-member credential —
 *      `/connect/org-invite/agent`); when the member is a demo account this Home can sign in as, their own session
 *      records the membership on the governor (`/connect/org-membership`, their OrganizationMembership, the
 *      countersigned credential) and the workspace's record is tombstoned; otherwise the invitation stands and the
 *      member's next `workspace-join` at the app completes it — the workspace's record is kept until then, so
 *      nobody is un-membered by a script.
 *
 * IDEMPOTENT: a workspace whose pointer already names a governor charters nothing and only moves what is left.
 * `--dry` reads everything and prints the plan; it signs nothing and writes nothing.
 *
 * NOT RUN as part of this change. The custodian's Home session is the only authority here; the script holds no key.
 */
import { hashDelegation, buildCaveat, buildDigestBindingCaveat, buildVaultRecordScopeCaveat, capabilityHandler, encodeTimestampTerms, encodeValueTerms, ROOT_AUTHORITY, type Delegation, type Caveat, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { buildOrganizationMembership, buildOrganizationMembershipCredentialSubject } from '@agenticprimitives/organization';
import { hashSituationV2 } from '@agenticprimitives/situations';
import { toCanonicalAgentId } from '@agenticprimitives/identity-directory-adapters';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { jcsCanonicalize } from '@agenticprimitives/types';
import { CONTRACTS } from '@agenticprimitives/contracts/deployments/faithchain';
import { keccak256, stringToBytes, type Address, type Hex } from 'viem';

const HOME = process.env.HOME_BASE ?? 'https://www.faithnet.me';
const CHAIN = 34348;
const MCP_SERVER_ID = process.env.MCP_SERVER_ID ?? 'demo-mcp';
const DM = CONTRACTS.delegationManager as Address;
const ENFORCERS = {
  delegationManager: DM, timestamp: CONTRACTS.timestampEnforcer, allowedTargets: CONTRACTS.allowedTargetsEnforcer, allowedMethods: CONTRACTS.allowedMethodsEnforcer,
  value: CONTRACTS.valueEnforcer, payment: CONTRACTS.paymentEnforcer, digestBinding: CONTRACTS.digestBindingEnforcer,
} as const;

const [handle, wsArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const DRY = process.argv.includes('--dry');
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
if (!handle || !wsArg || !/^0x[0-9a-fA-F]{40}$/.test(wsArg)) fail('usage: workspace-governor.mts <custodian-handle> <workspace-sa> [--dry]');
const WS = wsArg!.toLowerCase() as Address;
const lower = (s: string) => s.toLowerCase();
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const naming = new AgentNamingClient({ rpcUrl: process.env.RPC_URL ?? 'https://a2a.faithnet.io/rpc', chainId: CHAIN, registry: CONTRACTS.agentNameRegistry, universalResolver: CONTRACTS.agentNameUniversalResolver });
const randSalt = () => { let s = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) s = (s << 8n) | BigInt(b); return s; };
const wire = (d: Delegation) => ({ ...d, salt: d.salt.toString() });

// ── sessions: one per demo person, signed for by the Home ─────────────────────────────────────────────────
interface Who { handle: string; sa: Address; session: string; headers: Record<string, string>; auth: Record<string, string> }
async function signIn(h: string, as?: Address): Promise<Who> {
  const me = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: h, client_id: 'demo-web', ...(as ? { as } : {}) }) }));
  if (!me.agent || !me.homeSession) fail(`demo-signin ${h}${as ? ` as ${as}` : ''}: ${JSON.stringify(me).slice(0, 200)}`);
  const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
  const csrf = (await j(csrfRes)) as { token?: string };
  return {
    handle: h, sa: lower(String(me.agent)) as Address, session: me.homeSession,
    headers: { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' },
    auth: { 'content-type': 'application/json', authorization: `Bearer ${me.homeSession}` },
  };
}
/** The custodian's EIP-191 signature over a digest, by the Home — ERC-1271 by every agent that custodian holds. */
const signer = (who: Who) => async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: who.auth, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign (${who.handle}): ${JSON.stringify(b).slice(0, 160)}`);
  return b.signature as Hex;
};

// ── the vault, over a stewardship wire (the Home's own `vault-client`) ────────────────────────────────────
async function vault(who: Who, path: 'get' | 'list' | 'set', body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${HOME}/a2a/mcp/vault/${path}`, { method: 'POST', headers: who.headers, body: JSON.stringify(body) });
  const b = (await j(r)) as Record<string, unknown>;
  if (!r.ok || b.ok !== true) throw new Error(`vault ${path}: ${String(b.detail ?? b.error ?? r.status)}`);
  return b;
}
const vaultGet = (who: Who, d: unknown, recordType: string) => vault(who, 'get', { delegation: d, requester: who.sa, recordType }).then((b) => b.data ?? null);
const vaultSet = (who: Who, d: unknown, recordType: string, data: unknown) => vault(who, 'set', { delegation: d, requester: who.sa, recordType, data });
const vaultList = (who: Who, d: unknown) => vault(who, 'list', { delegation: d, requester: who.sa }).then((b) => (b.records ?? []) as Array<{ record_type: string }>);

// ── wires (the Home's own shapes, `src/lib/delegation.ts`) ────────────────────────────────────────────────
const yearOut = () => Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
/** org → member member-access (`issueOrganizationResourceAccessDelegation`): the org's shareable profile, read. */
async function memberAccess(sign: (d: Hex) => Promise<Hex>, org: Address, member: Address): Promise<Delegation> {
  const caveats: Caveat[] = [
    buildVaultRecordScopeCaveat([{ server: MCP_SERVER_ID, resources: ['vault:org.profile'], ops: ['read'] }] as never),
    buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, yearOut())), buildCaveat(CONTRACTS.valueEnforcer, encodeValueTerms(0n)),
  ];
  const d: Delegation = { delegator: org, delegate: member, authority: ROOT_AUTHORITY, caveats, salt: randSalt(), signature: '0x' };
  d.signature = await sign(hashDelegation(d, CHAIN, DM));
  return d;
}
/** member → org (`issueMemberProfileAccessDelegation`): the org reads the profile card the member keyed to it. */
async function memberConsent(sign: (d: Hex) => Promise<Hex>, member: Address, org: Address): Promise<Delegation> {
  const caveats: Caveat[] = [
    buildVaultRecordScopeCaveat([{ server: MCP_SERVER_ID, resources: [`vault:member.profile:${lower(org)}`], ops: ['read'] }] as never),
    buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, yearOut())), buildCaveat(CONTRACTS.valueEnforcer, encodeValueTerms(0n)),
  ];
  const d: Delegation = { delegator: member, delegate: org, authority: ROOT_AUTHORITY, caveats, salt: randSalt(), signature: '0x' };
  d.signature = await sign(hashDelegation(d, CHAIN, DM));
  return d;
}

// ── the two-sided credential (spec 410 §8; `src/lib/workspace-governor.ts` carries the same digest) ──────
const digestOf = (v: unknown): Hex => keccak256(stringToBytes(jcsCanonicalize(v)));
const termsDigestOf = (terms: Record<string, unknown>) => (Object.keys(terms).length ? digestOf(terms) : (`0x${'00'.repeat(32)}` as Hex));
async function offerHasMember(signAsOrg: (d: Hex) => Promise<Hex>, member: Address, org: Address) {
  const body = { type: 'ap.relationship-credential.v1', kind: 'has-member', subject: lower(member), object: lower(org), chainId: CHAIN, issuedAt: new Date().toISOString(), termsDigest: termsDigestOf({ role: 'member' }) };
  const digest = digestOf(body);
  return { ...body, terms: { role: 'member' }, digest, signatures: { object: await signAsOrg(digest) } };
}

// ── one act through the custodian's own Ask (`charter-cast.mts`'s loop, verbatim in spirit) ───────────────
type Reply = { kind?: string; error?: string; runRef?: string; resumeToken?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; result?: unknown; prompt?: { kind?: string; digest?: Hex; prompt?: string; stepRef?: string; signer?: string; payload?: unknown; fields?: unknown } };
async function actAs(who: Who, message: string, toolId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sign = signer(who);
  const custodian = (await j(await fetch(`${HOME}/connect/demo-personas`))).personas?.find((p: { sa?: string }) => lower(p.sa ?? '') === who.sa)?.custodian as string | undefined;
  if (!custodian) fail(`${who.handle}'s custodian EOA is not on the demo roster`);
  const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: who.headers, body: JSON.stringify(body) }));
  let r = await post('/harness/ask', { session: who.session, addressee: who.sa, message, plan: { steps: [{ toolId, args }] } });
  let rep = r.reply as Reply | undefined;
  console.log(`  ask → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
  for (let round = 0; round < 6; round++) {
    if (rep?.kind === 'authority_required' && rep.requirement && rep.delegator && rep.delegate) {
      const req = rep.requirement;
      const caveats: Caveat[] = [...capabilityHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req.intentDigest as Hex)];
      const salt = randSalt();
      const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
      const a = await post('/harness/authorize', { session: who.session, delegator: rep.delegator, digests: [hashDelegation(mandate, CHAIN, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
      if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
      const b2 = await post('/harness/authorize', { session: who.session, delegator: rep.delegator, userOp: a.userOp, signature: await sign(a.userOpHash as Hex) });
      if (b2.ok !== true) fail(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
      mandate.signature = '0x03';
      r = await post('/harness/ask', { session: who.session, addressee: who.sa, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
      rep = r.reply as Reply | undefined;
      console.log(`  resume → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
      continue;
    }
    if (rep?.kind === 'prompt' && rep.prompt?.kind === 'data' && Array.isArray(rep.prompt.fields)) {
      const fields = rep.prompt.fields as Array<{ name: string; type?: string }>;
      const supplied: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.type === 'credential') supplied[f.name] = { kind: 'eoa', address: custodian };
        else if (f.name === 'label') supplied[f.name] = args.label;
        else fail(`the act asks for data a script cannot answer: ${JSON.stringify(fields).slice(0, 300)}`);
      }
      r = await post('/harness/ask', { session: who.session, addressee: who.sa, runRef: rep.runRef, supplied: [{ stepRef: rep.resumeToken ?? rep.prompt.stepRef, data: supplied }] });
      rep = r.reply as Reply | undefined;
      console.log(`  supplied → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
      continue;
    }
    if (rep?.kind === 'prompt' && rep.prompt?.kind === 'signature' && rep.prompt.digest) {
      const p = rep.prompt as { digest: Hex; signer?: string; payload?: unknown; stepRef?: string };
      r = await post('/harness/ask', { session: who.session, addressee: who.sa, runRef: rep.runRef, supplied: [{ stepRef: rep.resumeToken ?? p.stepRef, signature: { digest: p.digest, signer: p.signer ?? custodian, signature: await sign(p.digest), ...(p.payload !== undefined ? { payload: p.payload } : {}) } }] });
      rep = r.reply as Reply | undefined;
      console.log(`  signed → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
      continue;
    }
    break;
  }
  if (!rep || rep.kind !== 'done') return fail(`${toolId} did not finish: ${JSON.stringify(r).slice(0, 700)}`);
  return (rep.result ?? {}) as Record<string, unknown>;
}

// ── 0. who, and what the workspace is ────────────────────────────────────────────────────────────────────
const me = await signIn(handle!);
type Row = { orgAgent: string; orgName?: string; kind?: string; parent?: string; relationship?: string; stewardshipDelegation?: unknown; governor?: string };
const rows = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: me.auth }))).orgs ?? []) as Row[];
const wsRow = rows.find((r) => lower(r.orgAgent) === WS);
if (!wsRow) fail(`${handle} holds no link to ${WS} — the custodian must be the one whose Home links the workspace`);
if (wsRow!.relationship === 'member' || !wsRow!.stewardshipDelegation) fail(`${handle} does not steward ${WS} (no stewardship wire on the link)`);
const wsName = wsRow!.orgName ?? (await naming.reverseResolve(WS).catch(() => null)) ?? WS;
const label = wsName.split('@')[0]!.split('.')[0]!;
console.log(`workspace ${wsName} (${WS}), custodied by ${handle} (${me.sa})`);

// Already governed? The pointer in the workspace's own vault is the one every reader keys on.
const pointer = (await vaultGet(me, wsRow!.stewardshipDelegation, 'workspace.governor').catch(() => null)) as { governedBy?: string } | null;
let governor = pointer?.governedBy && /^0x[0-9a-fA-F]{40}$/.test(pointer.governedBy) ? (lower(pointer.governedBy) as Address) : null;
let orgRow = governor ? rows.find((r) => lower(r.orgAgent) === governor) : undefined;
let orgStewardship: unknown = orgRow?.stewardshipDelegation ?? null;
let orgName = orgRow?.orgName ?? '';

// The memberships the workspace holds today — read first so `--dry` can say what would move.
const inventory = await vaultList(me, wsRow!.stewardshipDelegation).catch(() => [] as Array<{ record_type: string }>);
const memberKeys = inventory.map((r) => r.record_type).filter((k) => k.startsWith('org.membership:member:'));
const members: Array<{ sa: Address; record: Record<string, unknown> }> = [];
for (const k of memberKeys) {
  const rec = (await vaultGet(me, wsRow!.stewardshipDelegation, k).catch(() => null)) as Record<string, unknown> | null;
  if (rec) members.push({ sa: lower(k.slice('org.membership:member:'.length)) as Address, record: rec });
}
const personas = ((await j(await fetch(`${HOME}/connect/demo-personas`))).personas ?? []) as Array<{ handle: string; sa: string; custodian: string; custodies?: string[] }>;
/** How this Home can act as a member: a demo person by handle, a persona "as" under its custodian, or not at all. */
const sessionFor = (sa: Address): { handle: string; as?: Address } | null => {
  const direct = personas.find((p) => lower(p.sa) === sa);
  if (direct) return { handle: direct.handle };
  const custodian = personas.find((p) => (p.custodies ?? []).some((c) => lower(c) === sa));
  return custodian ? { handle: custodian.handle, as: sa } : null;
};

console.log(`\nPLAN${DRY ? ' (dry run — nothing is signed or written)' : ''}`);
console.log(governor ? `  · governor already recorded: ${orgName || governor}` : `  · charter ${label}.org as ${handle}, record the steward link + founder membership, write the pair, re-parent the link`);
console.log(`  · ${members.length} membership record(s) on the workspace:`);
for (const m of members) {
  const s = sessionFor(m.sa);
  console.log(`      ${m.sa}  ${m.sa === me.sa ? 'the custodian (already the founder)' : s ? `invite + join as ${s.handle}${s.as ? ' (persona)' : ''}, then tombstone` : 'invite only — a person this Home cannot sign for; their next join at the app completes it'}`);
}
if (DRY) process.exit(0);

// ── 1. the governing organization ───────────────────────────────────────────────────────────────────────
if (!governor) {
  const existing = (await naming.resolveName(`${label}.org`).catch(() => null))?.toLowerCase() as Address | null;
  const mine = existing ? rows.find((r) => lower(r.orgAgent) === existing && r.relationship !== 'member' && r.stewardshipDelegation) : undefined;
  if (existing && !mine) fail(`${label}.org already resolves to ${existing} and ${handle} does not steward it — pick a workspace whose organization name is free, or pass that organization's custodian`);
  if (mine) {
    governor = existing!; orgStewardship = mine.stewardshipDelegation; orgName = mine.orgName ?? `${label}.org`;
    console.log(`\n${label}.org already exists and ${handle} stewards it → ${governor}`);
  } else {
    console.log(`\n── ${handle} charters ${label}.org ──`);
    const created = await actAs(me, `create an organization called ${label}`, 'organization.create', { parent: me.sa, label });
    governor = lower(String(created.agent ?? '')) as Address;
    if (!/^0x[0-9a-f]{40}$/.test(governor)) fail(`organization.create answered with no agent: ${JSON.stringify(created).slice(0, 300)}`);
    orgName = String(created.name ?? `${label}.org`);
    orgStewardship = created.stewardshipDelegation ?? null;
    if (!orgStewardship) fail('the charter returned no stewardship wire — the organization is deployed but nothing here can write its vault');
    console.log(`  ${orgName} → ${governor}`);
    // Its link, the way the Home's ceremony records a chartered agent (`ask-record.ts`), and the founder's own
    // membership + steward relationship, the way org-create writes them (`createOrganization`).
    const link = await j(await fetch(`${HOME}/connect/related-orgs`, { method: 'POST', headers: me.auth, body: JSON.stringify({ person: me.sa, orgAgent: governor, orgName, purpose: 'workspace-governor', requestedBy: '', kind: 'org', parent: me.sa, relationship: 'steward', stewardshipDelegation: orgStewardship }) }));
    if (!link.ok) fail(`steward link: ${JSON.stringify(link).slice(0, 200)}`);
    const membershipId = `sit_mem_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')}` as `sit_${string}`;
    const membership = buildOrganizationMembership({
      id: membershipId, memberAgent: toCanonicalAgentId(CHAIN, me.sa), organizationAgent: toCanonicalAgentId(CHAIN, governor),
      body: { membershipEpoch: 1, status: 'active', membershipClass: 'standard', enrollmentSource: { kind: 'open-enrollment', enrollmentPolicyId: `org-create:${governor}` }, memberAcceptanceRef: `org-create:${me.sa}`, organizationDecisionRef: `org-create-decision:${governor}` },
    });
    const membershipSituationHash = hashSituationV2(membership);
    const credential = buildOrganizationMembershipCredentialSubject({ membership, claims: { membershipSituationHash, memberAcceptanceProof: `org-create:${me.sa}`, organizationAdmissionProof: `org-create-decision:${governor}` } });
    const put = await fetch(`${HOME}/a2a/interactions/${me.sa}/membership.put`, { method: 'POST', headers: me.headers, body: JSON.stringify({ session: me.session, org: governor, membership, credential }) });
    if (!put.ok) console.warn(`  founder membership not written (${put.status}) — re-mintable at the next enable ceremony`);
    await fetch(`${HOME}/a2a/interactions/${me.sa}/relationships.merge`, { method: 'POST', headers: me.headers, body: JSON.stringify({ session: me.session, entry: { org: governor, relationship: 'steward', orgName, delegations: [orgStewardship], membershipId, membershipSituationHash, enrollmentDecisionRef: `org-create-decision:${governor}` } }) }).catch(() => null);
    console.log('  steward link, founder membership and relationship recorded');
  }

  // ── 2. the pair ───────────────────────────────────────────────────────────────────────────────────────
  await vaultSet(me, orgStewardship, `workspace:${WS}`, { type: 'aporg:Workspace', governedBy: governor, coordinatedBy: WS, label: wsName, purpose: 'workspace-governor', createdAt: new Date().toISOString() });
  await vaultSet(me, wsRow!.stewardshipDelegation, 'workspace.governor', { governedBy: governor, coordinatedBy: WS });
  console.log(`  pair written: ${orgName} ⟷ ${wsName}`);

  // ── 3. the workspace hangs under its governor ─────────────────────────────────────────────────────────
  const re = await j(await fetch(`${HOME}/connect/related-orgs`, { method: 'POST', headers: me.auth, body: JSON.stringify({ person: me.sa, orgAgent: WS, parent: governor, governor, kind: 'workspace' }) }));
  if (!re.ok) fail(`re-parent: ${JSON.stringify(re).slice(0, 200)}`);
  console.log('  link re-parented under the organization');
}

// ── 4. the membership moves ─────────────────────────────────────────────────────────────────────────────
if (!orgStewardship) fail(`${handle} holds no stewardship wire over ${orgName || governor} — nothing here can invite for it`);
const signAsCustodian = signer(me);
for (const m of members) {
  if (m.sa === me.sa) { await vaultSet(me, wsRow!.stewardshipDelegation, `org.membership:member:${m.sa}`, null); console.log(`  ${m.sa}: the founder — workspace record tombstoned`); continue; }
  const access = wire(await memberAccess(signAsCustodian, governor!, m.sa));
  const offer = await offerHasMember(signAsCustodian, m.sa, governor!);
  const inv = await j(await fetch(`${HOME}/connect/org-invite/agent`, { method: 'POST', headers: me.auth, body: JSON.stringify({ org: governor, agent: m.sa, memberAccessDelegation: access, role: 'member', relationshipOffer: offer }) }));
  if (!inv.ok) { console.warn(`  ${m.sa}: the organization could not record the invitation — ${JSON.stringify(inv).slice(0, 160)}; the workspace's record stays`); continue; }
  const s = sessionFor(m.sa);
  if (!s) { console.log(`  ${m.sa}: invited into ${orgName}; their next join at the app records the membership — the workspace's record stays until then`); continue; }
  const them = await signIn(s.handle, s.as);
  const consent = wire(await memberConsent(signer(them), m.sa, governor!));
  const displayName = typeof m.record.displayName === 'string' ? m.record.displayName : undefined;
  const joined = await j(await fetch(`${HOME}/connect/org-membership`, { method: 'POST', headers: them.auth, body: JSON.stringify({ org: governor, delegation: consent, memberAccessDelegation: access, ...(displayName ? { displayName } : {}) }) }));
  if (!joined.ok) { console.warn(`  ${m.sa}: join refused — ${JSON.stringify(joined).slice(0, 160)}; the workspace's record stays`); continue; }
  const accepted = await j(await fetch(`${HOME}/a2a/relationships/credential/accept`, { method: 'POST', headers: them.headers, body: JSON.stringify({ session: them.session, offer, subjectSignature: await signer(them)(offer.digest) }) }));
  if (!accepted.ok) console.warn(`  ${m.sa}: the has-member credential was not countersigned — ${String(accepted.error ?? '')}`);
  await vaultSet(me, wsRow!.stewardshipDelegation, `org.membership:member:${m.sa}`, null);
  console.log(`  ${m.sa}: member of ${orgName}${joined.membershipRecorded === true ? ' (recorded)' : ' (the organization\'s own record did not land — see membershipError)'}; workspace record tombstoned`);
}
console.log(`\n✓ ${wsName} is governed by ${orgName} (${governor})`);
