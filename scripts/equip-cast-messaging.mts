/**
 * A CHARACTER'S OWN VOICE, DELIVERED BY THE CARD ROOM — the four ceremonies that let Game Night have a cast agent
 * send a direct message AS ITSELF, to another character's or a player's inbox, without a custodian being woken.
 *
 *   npx tsx scripts/equip-cast-messaging.mts --note demo/commission-cast.faithnet.json
 *   npx tsx scripts/equip-cast-messaging.mts --note demo/cast.faithnet.json                     (Mystery Night's)
 *   npx tsx scripts/verify-cast-messaging.mts --note demo/commission-cast.faithnet.json        (then prove one pair)
 *
 * WHAT WAS TRIED FIRST, AND WHY NOT. The card room holds session wires from each character pinned to
 * `messaging.deliver` (`mint-cast-wires.mts`). Spending one means calling the RECIPIENT's task runtime at its own
 * subdomain, and that door requires the estate's gateway assertion — a secret the card room does not hold and must
 * not. The open door is the STANDARD SURFACE (`edge/api/a2a/<name>`), which runs the character's own harness. So
 * the character's agent must send the message, and the card room must be able to ask it to (spec 400 W2a — an
 * outside runtime as the agent's own runtime). Four things make that true, per character:
 *
 *   1. THE PLAYBOOK OFFERS THE TOOL. `messaging.direct.send` is attached to the part's archetype in the skills
 *      registry (register-commission.mjs / register-place-story.mjs); `assign-org-archetype.mts` puts the new
 *      digest on the agent. Not done here — it is the registry's ceremony; this script checks it.
 *   2. THE RAIL (`enableMessaging`): the signing wire (character → the Home's interactions-session key) and the
 *      transport grant (character → character, naming the recipients). Without it an authorized send cannot
 *      leave (`wire_absent`). Installed on the character's own object by its custodian AS STEWARD.
 *   3. THE STANDING GRANT (`buildStandingGrant`, recorded on her object): character → the card room's session
 *      key, capability `messaging.direct.send`, bounded to the recipients, NO intent binding. That absence is the
 *      point — a capability, not a mandate — so the card room DERIVES the mandate for each line actually said and
 *      presents [child, standing]; the harness verifies every link where it is used. Revoke it on chain and the
 *      next derivation is refused everywhere.
 *   4. THE ASK WIRE: character → the card room's session key, pinned to `harness.ask`. This is what makes the
 *      card room THE CHARACTER'S OWN RUNTIME on the standard surface (principal-by-wire = the character), so the
 *      run is the agent's own and `messaging.direct.send` runs as itself. Asking as the HOUSE was refused: "a
 *      direct message is sent as you, and there is no signed-in person on this run".
 *
 * WHO MAY BE WRITTEN TO. The other parts of the same cast, and the demo people's own agents — whoever can take a
 * part tonight — so a whisper to a character a person is playing reaches that person's Home. Widening later is
 * re-running this script (the rail unions; the standing grant is re-minted).
 *
 * Every signature is the custodian's, at `/connect/persona-sign`, under their own Home session. The card room
 * signs only as itself. Output: demo/<name>-messaging.faithnet.json → the card room's `CAST_MESSAGING` secret.
 * Nothing here is a persona and nothing here is a key.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { hashDelegation, buildCaveat, encodeTimestampTerms, encodeAllowedMethodsTerms, ROOT_AUTHORITY, type Delegation } from '@agenticprimitives/delegation';
import { enableMessaging } from '@agenticprimitives/runtime-member/equip';
import { buildStandingGrant } from '@agenticprimitives/runtime-member/standing';
import { recordStandingGrant, standingEnforcers } from '@agenticprimitives/runtime-member/equip';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const A2A = process.env.A2A_URL ?? 'https://a2a.faithnet.io';
const REGISTRY = process.env.SKILLS_REGISTRY ?? 'https://skills-a2a-production.richardpedersen3.workers.dev';
const SESSION_KEY = (process.env.HOUSE_SESSION_KEY ?? '0x4A99377a047FB39e2AcBBF100a81A4aA564b104a') as Address;
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1]! : d; };
const NOTE = arg('note', 'demo/commission-cast.faithnet.json')!;
const OUT = arg('out', NOTE.replace('.faithnet.json', '-messaging.faithnet.json'))!;
const DAYS = Number(arg('days', '90'));
const ONLY = arg('only');
const PEOPLE = ['alice', 'bob', 'carol', 'dave', 'elena', 'nathan', 'david'];

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
const people: Address[] = []; for (const h of PEOPLE) people.push((await sessionFor(h)).agent);
const skillSelector = (s: string): Hex => keccak256(toBytes(s)).slice(0, 10) as Hex;

const prior = ((): Record<string, unknown> => { try { return JSON.parse(readFileSync(OUT, 'utf8')).parts ?? {}; } catch { return {}; } })();
const parts: Record<string, unknown> = { ...prior };
for (const part of cast) {
  if (ONLY && part.name !== ONLY && part.role !== ONLY) continue;
  const me = part.sa.toLowerCase() as Address;
  const { bearer, agent: custodianAgent } = await sessionFor(part.custodian);
  const signDigest = signerFor(bearer);
  console.log(`\n── ${part.character} · ${part.name} (${part.custodian} custodies) ──`);

  // 1. the playbook offers the tool — the registry's ceremony (assign-org-archetype.mts); proven by the run itself.
  const links = await j(await fetch(`${HOME}/connect/related-orgs`, { headers: { authorization: `Bearer ${bearer}` } }));
  const stewardship = (links.orgs as Array<Record<string, unknown>> | undefined)?.find((o) => String(o.orgAgent).toLowerCase() === me)?.stewardshipDelegation;
  if (!stewardship) throw new Error(`${part.custodian} holds no stewardship delegation for ${part.name} — charter-cast.mts records one`);

  // 2. the rail
  const recipients = [...new Set([...cast.map((p) => p.sa.toLowerCase() as Address), ...people])].filter((a) => a !== me);
  const rail = await enableMessaging({ a2a: A2A, member: me, recipients, contracts, custodian: { bearer, agent: custodianAgent, signDigest }, stewardship, validForSeconds: DAYS * 86_400 });
  console.log(`  rail: ${rail.recipients.length} recipients · wire ${rail.hash.slice(0, 14)}…`);

  // 3. the standing grant, recorded on her own object
  const standing = await buildStandingGrant({ member: me, runtimeKey: SESSION_KEY, capabilities: ['messaging.direct.send'], locations: recipients, validForSeconds: DAYS * 86_400, enforcers: standingEnforcers(contracts), chainId: contracts.chainId, delegationManager: contracts.delegationManager, signDigest });
  const recorded = await recordStandingGrant({ a2a: A2A, member: me, custodian: { bearer, agent: custodianAgent, signDigest }, stewardship, standing, holderName: 'gamenight.faithnet.io' });
  console.log(`  standing grant ${standing.ref.slice(0, 14)}… → card room session key · messaging.direct.send · recorded ${recorded.slice(0, 14)}…`);

  // 4. the ask wire
  const validUntil = Math.floor(Date.now() / 1000) + DAYS * 86_400;
  let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
  const d: Delegation = { delegator: me, delegate: SESSION_KEY, authority: ROOT_AUTHORITY, caveats: [buildCaveat(contracts.timestampEnforcer, encodeTimestampTerms(0, validUntil)), buildCaveat(contracts.allowedMethodsEnforcer, encodeAllowedMethodsTerms([skillSelector('harness.ask')]))], salt, signature: '0x' };
  d.signature = await signDigest(hashDelegation(d, contracts.chainId, contracts.delegationManager));
  console.log(`  ask wire → card room session key · harness.ask · until ${new Date(validUntil * 1000).toISOString().slice(0, 10)}`);

  parts[part.name] = { sa: me, role: part.role, character: part.character, wire: { ...d, salt: d.salt.toString() }, standing };
  writeFileSync(OUT, JSON.stringify({ purpose: 'each cast agent as its own runtime at the card room: an ask wire and a standing grant for messaging.direct.send (an operator note, not a persona)', sessionKey: SESSION_KEY, chainId: contracts.chainId, edge: 'https://edge.faithnet.io', parts }, null, 2) + '\n');
}
console.log(`\n✓ ${Object.keys(parts).length} part(s) → ${OUT}`);
console.log(`\nset it: cd ~/pokernight/apps/tables && pnpm exec wrangler secret put CAST_MESSAGING --env faithnet < <(node -e "process.stdout.write(JSON.stringify(require('${process.cwd()}/${OUT}')))")`);
