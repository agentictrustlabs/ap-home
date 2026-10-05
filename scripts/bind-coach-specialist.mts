/**
 * BIND A PERSON TO A HOLD'EM COACHING SERVICE — the two custodial acts a person does at their Home so that
 * their own agent consults that coach at the table (`apps/agent-runtime/src/card-room.ts`):
 *
 *   npx tsx scripts/bind-coach-specialist.mts <handle> <coach.svc>          e.g. alice bob-coach.svc
 *   npx tsx scripts/bind-coach-specialist.mts <handle> <coach.svc> --unbind
 *
 *  1. THE PLAYBOOK NAMES THE SPECIALIST. The person's archetype assignment (their vault, their session) gains
 *     `specialists: [{ capability: 'poker.advise', executor: '<coach.svc>' }, { capability: 'poker.review', … }]`
 *     and its definition digest is recomputed — the same record the ceremony writes (spec 376 W2: behaviour,
 *     never authority). The person's harness verifies the digest at every run admission.
 *  2. THE STUDY GRANT. A vault-record-scope delegation: delegator the person, delegate the SERVICE (never the
 *     coach as a person), READ on `vault:cardroom.hand|style|read|note`, WRITE on `vault:cardroom.note` only, a
 *     one-year window, revocable on chain. Signed by the person (persona-sign → ERC-1271 by their agent) and
 *     stored on their own object (`studygrant.put`), where their agent reads it to present at each consultation.
 *
 * Neither act lets the coach do anything at the table: the table addresses the person's agent, which forwards
 * the same seat payload with this grant; the coach answers in its own name. `--unbind` clears both, which is
 * what "fire my coach" looks like from the Home's side (the on-chain revoke is the authority kill).
 */
import { buildCaveat, buildVaultRecordScopeCaveat, encodeTimestampTerms, hashDelegation, ROOT_AUTHORITY, type Delegation } from '@agenticprimitives/delegation';
import { definitionDigest, validateAgentHarnessDefinition, type AgentHarnessDefinitionV1 } from '@agenticprimitives/capability-claims';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { CONTRACTS } from '@agenticprimitives/contracts/deployments/faithchain';
import { toHex, type Address, type Hex } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const CHAIN = 34348;
const DAYS = Number(process.env.DAYS ?? 365);
const SERVER = 'demo-mcp';
// ONE CABINET PER GAME: hold'em's records are the bare names; canasta's carry the family (`cardroom.canasta.hand`).
const GAME = process.argv.includes('--game') ? String(process.argv[process.argv.indexOf('--game') + 1]).toLowerCase() : 'poker';
if (!['poker', 'canasta'].includes(GAME)) { console.error('--game must be poker or canasta'); process.exit(2); }
const INFIX = GAME === 'poker' ? '' : `${GAME}.`;
// …plus the ONE record shared across games: the person's profile (`cardroom.profile`).
const READS = [`vault:cardroom.${INFIX}hand`, `vault:cardroom.${INFIX}hands:*`, `vault:cardroom.${INFIX}style`, `vault:cardroom.${INFIX}read`, `vault:cardroom.${INFIX}note`, 'vault:cardroom.profile'];
const APPENDS = [`vault:cardroom.${INFIX}note`];
const SKILLS = [`${GAME}.advise`, `${GAME}.review`];

const [handle, coach] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--game');
const unbind = process.argv.includes('--unbind');
if (!handle || !coach || !/\.svc$/.test(coach)) { console.error('usage: bind-coach-specialist.mts <handle> <coach.svc> [--game poker|canasta] [--unbind]'); process.exit(2); }

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };

const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
const token: string = si.homeSession; const ME = String(si.agent ?? '').toLowerCase() as Address;
if (!token || !/^0x[0-9a-f]{40}$/.test(ME)) fail(`no session for ${handle}: ${JSON.stringify(si).slice(0, 200)}`);
const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: auth, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`); return b.signature; };
const naming = new AgentNamingClient({ rpcUrl: RPC, chainId: CHAIN, registry: CONTRACTS.agentNameRegistry as Address, universalResolver: CONTRACTS.agentNameUniversalResolver as Address });
const coachSA = (await naming.resolveName(coach).catch(() => null))?.toLowerCase() as Address | undefined;
if (!coachSA) fail(`${coach} does not resolve — charter it first (scripts/charter-coach.mts)`);
console.log(`${handle}.me ${ME} → coach ${coach} ${coachSA}`);

// ── 1. the playbook's specialists ──
const channels = async (body: Record<string, unknown>) => j(await fetch(`${HOME}/connect/channels`, { method: 'POST', headers: auth, body: JSON.stringify({ communityId: ME, ...body }) }));
const got = await channels({ action: 'archetypeAssignmentGet' }) as { ok?: boolean; record?: { type: string; definition: AgentHarnessDefinitionV1; definitionDigest: string } | null; error?: string };
if (!got.ok || !got.record?.definition) fail(`${handle} has no archetype assignment (${got.error ?? 'none'}) — run scripts/assign-person-archetype.mts ${handle} first`);
const def = got.record!.definition;
const others = (def.specialists ?? []).filter((s) => !SKILLS.includes(s.capability));
const specialists = unbind ? others : [...others, ...SKILLS.map((capability) => ({ capability, executor: coach }))];
const nextDef: AgentHarnessDefinitionV1 = { ...def, ...(specialists.length ? { specialists } : {}) };
if (!specialists.length) delete (nextDef as { specialists?: unknown }).specialists;
const check = validateAgentHarnessDefinition(nextDef);
if (!check.ok) fail(`the definition would not validate: ${check.errors.join('; ')}`);
const digest = definitionDigest(nextDef);
if (digest === got.record!.definitionDigest && JSON.stringify(def.specialists ?? []) === JSON.stringify(specialists)) console.log(`  · playbook already ${unbind ? 'names no coach' : `names ${coach}`} (digest ${digest.slice(0, 12)}…)`);
else {
  const put = await channels({ action: 'archetypeAssignmentPut', record: { ...got.record, definition: nextDef, definitionDigest: digest } });
  if (put.ok !== true) fail(`assignment put: ${JSON.stringify(put).slice(0, 300)}`);
  console.log(`  playbook specialists ← ${JSON.stringify(specialists)} · digest ${digest.slice(0, 12)}…`);
}

// ── 2. the study grant ──
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
const op = async (name: string, body: Record<string, unknown>) => j(await fetch(`${HOME}/a2a/interactions/${ME}/${name}`, { method: 'POST', headers: H, body: JSON.stringify({ session: token, ...body }) }));
if (unbind) {
  const r = await op('studygrant.revoke', { coach });
  console.log(`  study grant for ${coach}: ${JSON.stringify(r).slice(0, 160)}`);
} else {
  const listed = await op('studygrant.list', {}) as { grants?: Array<{ coach: string; hash: string; revoked: boolean }> };
  const have = listed.grants?.find((g) => g.coach === coach && !g.revoked);
  if (have && !process.env.REISSUE) console.log(`  · study grant for ${coach} already stored (${have.hash.slice(0, 12)}…) — REISSUE=1 to re-sign`);
  else {
    const validUntil = Math.floor(Date.now() / 1000) + DAYS * 86_400;
    const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
    const d: Delegation = {
      delegator: ME, delegate: coachSA!, authority: ROOT_AUTHORITY,
      caveats: [
        buildCaveat(CONTRACTS.timestampEnforcer as Address, encodeTimestampTerms(0, validUntil)),
        buildVaultRecordScopeCaveat([{ server: SERVER, resources: READS, ops: ['read'] }, { server: SERVER, resources: APPENDS, ops: ['write'] }]),
      ],
      salt, signature: '0x',
    };
    d.signature = await sign(hashDelegation(d, CHAIN, CONTRACTS.delegationManager as Address));
    const r = await op('studygrant.put', { coach, delegation: { ...d, salt: salt.toString() } });
    if (r.ok !== true) fail(`studygrant.put: ${JSON.stringify(r).slice(0, 300)}`);
    console.log(`  study grant ← ${coach} ${coachSA} · hash ${String(r.hash).slice(0, 12)}… · reads ${READS.length} · appends ${APPENDS.length} · ${DAYS} days`);
  }
}
const after = await op('studygrant.list', {});
console.log(`\n✓ ${handle}.me: ${JSON.stringify(after.grants ?? after).slice(0, 300)}`);
