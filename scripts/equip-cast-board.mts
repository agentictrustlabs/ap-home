/**
 * A CHARACTER SPEAKS ON THE CLUB'S BOARD — the second half of the cast's messaging (2026-09-18). The first half
 * (`equip-cast-messaging.mts`) lets a cast agent send a direct message as itself: a whisper. This half lets it POST IN
 * A TOPIC of a club's workspace: room talk, in the night's topic on the club's board, where the club's people talk.
 *
 *   npx tsx scripts/equip-cast-board.mts --note demo/greeley-cast.faithnet.json --club <address|name>[,<more>] --host alice
 *   npx tsx scripts/equip-cast-board.mts --note demo/cast.faithnet.json --club <address> --host alice   (Mystery Night's)
 *
 * Two things make it true, per character and per club, and both are the same kind of thing the first half did:
 *
 *   1. THE CHARACTER IS A MEMBER OF THE CLUB. `messaging.topic.post` is a MEMBER's act: the organization's object
 *      admits a post from an agent only against its own invitation record (`org.invite:agent:<sa>`), and that
 *      record is written when the club's steward INVITES the agent — a club → character member-access grant, signed by
 *      the workspace's custody (the host's credential) and stored in the club's own vault by the steward-gated
 *      `/connect/org-invite/agent`. So the club's HOST invites the cast, as a host invites anybody. Nothing else here
 *      is the club's: the topic is opened by the club's own agent when the card room asks (`club.topic`).
 *   2. THE STANDING GRANT COVERS THE VERB AND THE PLACE. Re-minted: character → the card room's session key,
 *      capabilities `messaging.direct.send` AND `messaging.topic.post`, locations the recipients as before PLUS the
 *      clubs — no intent binding, so the card room derives the mandate for each line actually said. The ask wire is
 *      unchanged (it names the surface, not the verb). The archetype already offers the tool (`SPEAKS` in the
 *      registry scripts).
 *
 * The note file is updated in place (`standing` per part; `clubs` on the head), and the KV note is rebuilt by the
 * finisher as before. Re-running is safe: an invitation is re-written pending, a grant is re-minted.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';
import { buildCaveat, buildVaultRecordScopeCaveat, encodeTimestampTerms, encodeValueTerms, hashDelegation, ROOT_AUTHORITY, type Delegation } from '@agenticprimitives/delegation';
import { buildStandingGrant } from '@agenticprimitives/runtime-member/standing';
import { recordStandingGrant, standingEnforcers } from '@agenticprimitives/runtime-member/equip';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const A2A = process.env.A2A_URL ?? 'https://a2a.faithnet.io';
const SESSION_KEY = (process.env.HOUSE_SESSION_KEY ?? '0x4A99377a047FB39e2AcBBF100a81A4aA564b104a') as Address;
/** The vault's resource-server id every grant the Home issues names — faithnet was provisioned under demo-mcp. */
const MCP_SERVER_ID = (process.env.VAULT_SERVER_ID ?? '').trim() || 'demo-mcp';
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1]! : d; };
const NOTE = arg('note', 'demo/greeley-cast.faithnet.json')!;
const OUT = arg('out', NOTE.replace('.faithnet.json', '-messaging.faithnet.json'))!;
const CLUB_ARG = arg('club');
const HOST = arg('host', 'alice')!;
const DAYS = Number(arg('days', '90'));
const ONLY = arg('only');
const PEOPLE = ['alice', 'bob', 'carol', 'dave', 'elena', 'nathan', 'david'];
if (!CLUB_ARG) throw new Error('--club <address|name> required (the club workspace the cast will speak in)');

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
type Part = { name: string; sa: string; custodian: string; character: string; role: string };
const cast: Part[] = JSON.parse(readFileSync(NOTE, 'utf8')).cast ?? [];
if (!cast.length) throw new Error(`no cast in ${NOTE}`);

const sessions = new Map<string, { bearer: string; agent: Address }>();
const sessionFor = async (handle: string) => {
  if (!sessions.has(handle)) {
    const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
    if (!si.homeSession) throw new Error(`no session for ${handle}: ${JSON.stringify(si).slice(0, 200)}`);
    sessions.set(handle, { bearer: si.homeSession, agent: String(si.agent).toLowerCase() as Address });
  }
  return sessions.get(handle)!;
};
const signerFor = (bearer: string) => async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 200)}`);
  return b.signature as Hex;
};

const dep = await j(await fetch(`${A2A}/deployments`));
if (!dep.delegationManager) throw new Error(`no deployments at ${A2A}`);
const contracts = {
  chainId: Number(dep.chainId), delegationManager: dep.delegationManager as Address,
  timestampEnforcer: dep.timestampEnforcer as Address, allowedMethodsEnforcer: dep.allowedMethodsEnforcer as Address,
  valueEnforcer: dep.valueEnforcer as Address, allowedTargetsEnforcer: dep.allowedTargetsEnforcer as Address,
  agentRelationship: '0x0000000000000000000000000000000000000000' as Address, agentNameRegistry: '0x0000000000000000000000000000000000000000' as Address, permissionlessSubregistry: '0x0000000000000000000000000000000000000000' as Address,
  digestBindingEnforcer: (dep.digestBindingEnforcer ?? process.env.DIGEST_BINDING_ENFORCER ?? '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1') as Address,
};

// The clubs (comma-separated): addresses, or names the Home resolves. One host custodies them all for this run.
const resolveClub = async (c: string): Promise<Address> => {
  if (/^0x[0-9a-fA-F]{40}$/.test(c)) return c.toLowerCase() as Address;
  const r = await j(await fetch(`${HOME}/connect/name-info?name=${encodeURIComponent(c)}`));
  if (!r.exists || !r.agent) throw new Error(`${c} does not resolve at ${HOME}`);
  return String(r.agent).toLowerCase() as Address;
};
const wanted: Address[] = [];
for (const c of CLUB_ARG.split(',').map((x) => x.trim()).filter(Boolean)) wanted.push(await resolveClub(c));
const host = await sessionFor(HOST);
const signAsClub = signerFor(host.bearer); // the workspace's custody is the host's credential
console.log(`${wanted.length} club(s) · host ${HOST} (${host.agent})`);

const people: Address[] = []; for (const h of PEOPLE) people.push((await sessionFor(h)).agent);

const note = JSON.parse(readFileSync(OUT, 'utf8')) as { parts: Record<string, { sa: string; role: string; character: string; wire: unknown; standing: unknown }>; clubs?: string[]; [k: string]: unknown };
const clubs = [...new Set([...(note.clubs ?? []).map((c) => c.toLowerCase()), ...wanted])] as Address[];

for (const part of cast) {
  if (ONLY && part.name !== ONLY && part.role !== ONLY) continue;
  const me = part.sa.toLowerCase() as Address;
  const { bearer, agent: custodianAgent } = await sessionFor(part.custodian);
  const signDigest = signerFor(bearer);
  console.log(`\n── ${part.character} · ${part.name} (${part.custodian} custodies) ──`);
  const links = await j(await fetch(`${HOME}/connect/related-orgs`, { headers: { authorization: `Bearer ${bearer}` } }));
  const stewardship = (links.orgs as Array<Record<string, unknown>> | undefined)?.find((o) => String(o.orgAgent).toLowerCase() === me)?.stewardshipDelegation;
  if (!stewardship) throw new Error(`${part.custodian} holds no stewardship delegation for ${part.name} — charter-cast.mts records one`);

  // 1. each club invites the character — club → character member access, signed by the club's custody, in the club's vault
  for (const club of wanted) {
    const validUntil = Math.floor(Date.now() / 1000) + 365 * 86_400;
    let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
    const mad: Delegation = {
      delegator: club, delegate: me, authority: ROOT_AUTHORITY, salt, signature: '0x',
      caveats: [
        buildVaultRecordScopeCaveat([{ server: MCP_SERVER_ID, resources: ['vault:org.profile'], ops: ['read'] }]),
        buildCaveat(contracts.timestampEnforcer, encodeTimestampTerms(0, validUntil)),
        buildCaveat(contracts.valueEnforcer, encodeValueTerms(0n)),
      ],
    };
    mad.signature = await signAsClub(hashDelegation(mad, contracts.chainId, contracts.delegationManager));
    // THE VAULT WRITE IS TRIED TWICE: one club in seven answered "auth failed" once and never again, and a whole cast's
    // run should not stop on a hiccup in one club's vault. A second refusal is reported and the cast goes on.
    let inv: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      inv = await j(await fetch(`${HOME}/connect/org-invite/agent`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${host.bearer}` }, body: JSON.stringify({ org: club, agent: me, memberAccessDelegation: { ...mad, salt: mad.salt.toString() }, role: part.role }) }));
      if (inv.ok === true) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (inv.ok !== true) { console.log(`  ✗ club ${club} did not invite ${part.name}: ${JSON.stringify(inv).slice(0, 200)} — re-run for this club`); continue; }
    console.log(`  invited into ${club.slice(0, 10)}… as ${part.role}`);
  }

  // 2. the standing grant, re-minted: both verbs, the recipients and the clubs
  const recipients = [...new Set([...cast.map((p) => p.sa.toLowerCase() as Address), ...people])].filter((a) => a !== me);
  const standing = await buildStandingGrant({ member: me, runtimeKey: SESSION_KEY, capabilities: ['messaging.direct.send', 'messaging.topic.post'], locations: [...recipients, ...clubs], validForSeconds: DAYS * 86_400, enforcers: standingEnforcers(contracts), chainId: contracts.chainId, delegationManager: contracts.delegationManager, signDigest });
  const recorded = await recordStandingGrant({ a2a: A2A, member: me, custodian: { bearer, agent: custodianAgent, signDigest }, stewardship, standing, holderName: 'gamenight.faithnet.io' });
  console.log(`  standing grant ${standing.ref.slice(0, 14)}… → card room session key · direct.send + topic.post · ${clubs.length} club(s) · recorded ${recorded.slice(0, 14)}…`);

  const prior = note.parts[part.name];
  if (!prior) throw new Error(`${part.name} has no ask wire in ${OUT} — run equip-cast-messaging.mts first`);
  note.parts[part.name] = { ...prior, standing };
  note.clubs = clubs;
  writeFileSync(OUT, JSON.stringify(note, null, 2) + '\n');
}
console.log(`\n✓ ${cast.length} part(s) may speak in ${clubs.length} club(s) → ${OUT}`);
console.log(`  then rebuild the KV note (finish-*-cast.sh's last step) and put it under cast-messaging in CLUB_WIRES`);
