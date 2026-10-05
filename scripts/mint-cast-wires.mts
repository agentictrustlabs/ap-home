/**
 * A CHARACTER'S OWN VOICE ON THE WIRE — one session wire per cast agent, to the card room's session key.
 *
 *   npx tsx scripts/mint-cast-wires.mts                 (every part in demo/cast.faithnet.json)
 *   npx tsx scripts/mint-cast-wires.mts --days 90
 *
 * WHY THE HOUSE CANNOT SPEAK FOR THEM. When Mme Perrin says something in the lounge, the card room wants
 * Émile's agent to receive it AS FROM PERRIN — in his inbox, at his Home, under her name. The Home's
 * `messaging.deliver` binds `envelope.from` to the VERIFIED sender: the delegator of the wire the caller
 * presents (NEW-H1, which closed a forged-author hole). So the house, presenting its own wire, may deliver
 * only as the house. To deliver as Perrin it must present a wire PERRIN signed.
 *
 * WHAT IS SIGNED, AND HOW NARROW. delegator = the character's own agent; delegate = the card room's
 * session key (the same key the house wire delegates to — one key, many wires); allowedTargets pinned to
 * the character itself; allowedMethods pinned to `messaging.deliver` and nothing else. The card room can
 * carry her words to another character's door and can do nothing else in her name: not ask, not act, not
 * pay. Time-boxed and revocable on chain by her custodian without a redeploy.
 *
 * WHO SIGNS. Her custodian, through `/connect/persona-sign` — the one credential the character's account
 * accepts, the same one that chartered her. It is the identical shape to the club's `service-agent-wire`,
 * which is the point: a character in a story is an agent in the estate, and the estate already has the word
 * for "this agent lets that service carry its messages".
 *
 * The wires are written to demo/cast-wires.faithnet.json, keyed by character name, to become the card
 * room's `MYSTERY_CAST_WIRES` secret. Nothing here is a persona and nothing here is a key.
 */
import { hashDelegation, buildCaveat, encodeTimestampTerms, encodeAllowedTargetsTerms, encodeAllowedMethodsTerms, ROOT_AUTHORITY, type Delegation, type Caveat } from '@agenticprimitives/delegation';
import { readFileSync, writeFileSync } from 'node:fs';
import { keccak256, toBytes, type Address, type Hex } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = { timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41' } as const;
/** The card room's session key — the delegate of the house wire, and now of every character's. */
const SESSION_KEY = (process.env.HOUSE_SESSION_KEY ?? '0x4A99377a047FB39e2AcBBF100a81A4aA564b104a') as Address;
const NOTE_PATH = process.env.NOTE ?? 'demo/cast.faithnet.json';
const OUT_PATH = process.env.OUT ?? 'demo/cast-wires.faithnet.json';
const argv = process.argv.slice(2);
const days = argv.includes('--days') ? Number(argv[argv.indexOf('--days') + 1]) : 90;

/** The same 4-byte selector the Home derives for a skill — `keccak256(name)[0:4]`. */
const skillSelector = (skill: string): Hex => keccak256(toBytes(skill)).slice(0, 10) as Hex;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };

const cast: Array<{ name: string; sa: string; custodian: string; character: string; role: string }> = JSON.parse(readFileSync(NOTE_PATH, 'utf8')).cast ?? [];
if (!cast.length) throw new Error(`no cast in ${NOTE_PATH} — run charter-cast.mts first`);

const sessions = new Map<string, string>();
const sessionFor = async (handle: string): Promise<string> => {
  if (!sessions.has(handle)) {
    const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
    if (!si.homeSession) throw new Error(`no session for ${handle}: ${JSON.stringify(si).slice(0, 200)}`);
    sessions.set(handle, si.homeSession);
  }
  return sessions.get(handle)!;
};

const wires: Record<string, unknown> = {};
for (const part of cast) {
  const identity = String(part.sa).toLowerCase() as Address;
  const token = await sessionFor(part.custodian);
  const validUntil = Math.floor(Date.now() / 1000) + days * 86_400;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n; for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  const caveats: Caveat[] = [
    buildCaveat(ENFORCERS.timestamp as Address, encodeTimestampTerms(0, validUntil)),
    buildCaveat(ENFORCERS.allowedTargets as Address, encodeAllowedTargetsTerms([identity])),
    buildCaveat(ENFORCERS.allowedMethods as Address, encodeAllowedMethodsTerms([skillSelector('messaging.deliver')])),
  ];
  const d: Delegation = { delegator: identity, delegate: SESSION_KEY, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  const digest = hashDelegation(d, CHAIN, DM);
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign for ${part.name}: ${JSON.stringify(b).slice(0, 160)}`);
  d.signature = b.signature as Hex;
  wires[part.name] = { ...d, salt: d.salt.toString() };
  console.log(`${part.name.padEnd(20)} ${part.character.padEnd(16)} wire signed by ${part.custodian} · until ${new Date(validUntil * 1000).toISOString().slice(0, 10)}`);
}
writeFileSync(OUT_PATH, JSON.stringify({ purpose: 'session wires from each cast agent to the card room: messaging.deliver only (an operator note, not a persona)', sessionKey: SESSION_KEY, chainId: CHAIN, wires }, null, 2) + '\n');
console.log(`\n✓ ${Object.keys(wires).length} wire(s) → ${OUT_PATH}`);
console.log(`\nset it: cd ~/pokernight/apps/tables && pnpm exec wrangler secret put MYSTERY_CAST_WIRES --env faithnet < <(node -e "process.stdout.write(JSON.stringify(require('${process.cwd()}/${OUT_PATH}').wires))")`);
