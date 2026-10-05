/**
 * PUT MYSTERY NIGHT'S SKILLS ON AN AGENT'S CARD — the Home act a card room cannot do.
 *
 *   npx tsx scripts/add-mystery-skills.mts <handle>              (a character: mystery.act, mystery.consult)
 *   npx tsx scripts/add-mystery-skills.mts <handle> --director   (…and mystery.direct, the night's narrator)
 *   then: npx tsx scripts/rebuild-card-release.mts <handle> && npx tsx scripts/republish-card-record.mts <handle>
 *
 *   npx tsx scripts/add-mystery-skills.mts --as emile-elena.me --by elena   (a PERSONA of elena's)
 *
 * A PERSONA IS THE CASE THE GAME ACTUALLY USES. A character in the story is a second person agent of a real
 * demo person — `emile-elena.me` custodied by elena — and it takes the same road a service does: the custodian
 * signs, the agent's OWN Smart Agent is the userOp sender, and the card is built from the profile rather than
 * from a Studio draft (only a person's DEFAULT agent has one). What stays different is the Studio step below,
 * which is skipped for anything that is not the handle's own agent.
 *
 * WHY A CARD DECIDES. Game Night's `MysteryDO` refuses to ask an agent to play a part unless the agent's own
 * card advertises `mystery.act` — checked by name, once, so nobody discovers mid-scene that a character
 * cannot answer (`apps/tables/src/mystery-a2a.ts`). The skill on the card is also what the Home's harness
 * reads (`readAdvertisedCapabilityIds`) to decide which questions this agent ANSWERS at all: without it the
 * question is refused before a model ever sees it, and with it the agent answers from its own playbook.
 *
 * WHAT THE SKILLS ARE. `mystery.act` is a character's turn: the staging sends that character's own redacted
 * view — their room, who is in it, what they hold, what they have heard, and, for exactly one of them, that
 * they are the one who did it — and the agent answers with ONE action and ONE line, in character. The ENGINE
 * validates the action; an agent cannot walk through a wall because it said so. `mystery.direct` is the
 * night's narration: the public half of the story and the facts the engine has already decided, answered
 * with prose — it cannot invent a clue, move anybody or name a killer, because none of those are in the
 * shape of the answer. `mystery.consult` is the character's own player asking it what they would do.
 *
 * IT GRANTS NOTHING, and it costs the house nothing: whoever's agent answers, thinks at their own Home.
 */

import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { buildExecuteBatchCallData } from '@agenticprimitives/agent-account';
import { agentProfileResolverAbi } from '@agenticprimitives/agent-profile';
import { CONTRACTS } from '@agenticprimitives/contracts/deployments/faithchain';
import { createPublicClient, encodeFunctionData, http, keccak256, toBytes, type Address, type Hex } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const argv = process.argv.slice(2);
// `--service <name.svc>` and `--as <name>` are the SAME road under two words: another agent this person
// custodies, written by them. `--service` is kept because the coach scripts say it; `--as` is what a persona
// reads as, and it accepts a `.me` too — a character in the story is a person, not a service.
const otherName = argv.includes('--as') ? argv[argv.indexOf('--as') + 1]
  : argv.includes('--service') ? argv[argv.indexOf('--service') + 1] : undefined;
const handle = otherName ? (argv.includes('--by') ? argv[argv.indexOf('--by') + 1] : undefined) : argv[0];
/** A DIRECTOR also narrates the night; every other agent only plays a part in it. */
const directs = argv.includes('--director');
/**
 * WHICH GAME. `--game commission` writes Great Commission's skills (`commission.act`, `commission.consult`,
 * `commission.direct`) and `--game fieldops` writes Field Operations' (`fieldops.act`, `fieldops.consult`,
 * `fieldops.direct`) with the same road; the default is Mystery Night's. Three games, one script, because
 * the act of putting a skill on a card does not know what the skill is for.
 */
const game = argv.includes('--game') ? argv[argv.indexOf('--game') + 1] : 'mystery';
if (!handle || (otherName && !/\.(svc|me)$/.test(otherName))) throw new Error('usage: add-mystery-skills.mts <handle> [--director] | --as <name.me|name.svc> --by <custodian handle> [--director]');

/** Mystery Night's skills, spelled exactly as `@pokernight/protocol` spells them and as the staging checks. */
const ACT = { id: 'mystery.act', name: 'Play a part in a mystery', description: 'Take one moment as a character in a murder mystery: you are sent that character\u2019s own redacted view \u2014 their room, who is in it, what they hold, what they have heard, who they are and what only they know \u2014 and you answer with ONE action and ONE line, in character, first person. The actions are the game\u2019s own (move, say, whisper, examine, search, share, testify, alibi, accuse; and for the one who did it, murder and plant). The engine validates what you choose; nothing you say decides a fact.', tags: ['mystery.act', 'mystery', 'character', 'story', 'gamenight'] };
const CONSULT = { id: 'mystery.consult', name: 'What would my character do', description: 'Answer the person playing this character when they ask what to do next, from the same view they have and nothing else \u2014 one suggestion and the reason for it. A prompt, never a turn: the person acts.', tags: ['mystery.consult', 'mystery', 'character', 'gamenight'] };
const DIRECT = { id: 'mystery.direct', name: 'Direct a mystery night', description: 'Narrate a murder mystery as the house voice: you are sent the PUBLIC half of the story and the facts the engine has already decided \u2014 an act opening, a body found, a room turned over \u2014 and you answer with prose that carries them, and at most a nod at a room or a thing that already exists. You cannot invent a clue, move a character, or name a killer: none of those are in the shape of the answer.', tags: ['mystery.direct', 'mystery', 'director', 'story', 'gamenight'] };
const C_ACT = { id: 'commission.act', name: 'Play a part in a Great Commission night', description: 'Take one moment as a part in a Great Commission night — a substrate test played as a game: you are sent that part\u2019s own view (its room and the room\u2019s grain, its vault with each item\u2019s projections, what it has been shown, the board) and you answer with ONE action and ONE line, in character. Testify only to what you hold and only as coarsely as the room allows; the engine records every leak, fabrication and replay. Nothing you say decides what has happened among any people.', tags: ['commission.act', 'commission', 'great-commission', 'gamenight'] };
const C_CONSULT = { id: 'commission.consult', name: 'What would my part do', description: 'Answer the person playing this part when they ask what to do next, from the same view they have and nothing else \u2014 one suggestion and the reason for it, never a grain the room does not allow. A prompt, never a turn.', tags: ['commission.consult', 'commission', 'gamenight'] };
const C_DIRECT = { id: 'commission.direct', name: 'Direct a Great Commission night', description: 'Narrate a Great Commission night as the house voice: the region between rounds, what has moved and what has stalled, at province grain and never finer. You carry facts the engine has settled and invent none; you never name a village, a household or a person.', tags: ['commission.direct', 'commission', 'director', 'gamenight'] };
const F_ACT = { id: 'fieldops.act', name: 'Play a part in a Field Operations season', description: 'Take one DAY as a part in a Field Operations season — a season of field work north of Denver, played by real agents: you are sent your own view (where you stand, your team, the communities and circles there, the board, and the engine\u2019s own list of what you may do today) and you answer with ONE action and ONE line, in character. Choose only from the "may" list. Nothing you say decides what comes of an act; the season\u2019s seed does, and the records say what it answered.', tags: ['fieldops.act', 'fieldops', 'field-operations', 'gamenight'] };
const F_CONSULT = { id: 'fieldops.consult', name: 'What would my part do today', description: 'Answer the person playing this part when they ask what to do today, from the same view they have and nothing else \u2014 one suggestion and the reason for it, chosen from what the view says they may do. A prompt, never a turn.', tags: ['fieldops.consult', 'fieldops', 'gamenight'] };
const F_DIRECT = { id: 'fieldops.direct', name: 'Narrate a Field Operations season', description: 'Narrate a season of field work between weeks as the field\u2019s own voice: which teams moved and which stalled, at town grain and never finer. You carry facts the engine has settled and invent none; you never name a household or a person outside the cast.', tags: ['fieldops.direct', 'fieldops', 'director', 'gamenight'] };
const SKILLS = game === 'fieldops' ? (directs ? [F_ACT, F_CONSULT, F_DIRECT] : [F_ACT, F_CONSULT]) : game === 'commission' ? (directs ? [C_ACT, C_CONSULT, C_DIRECT] : [C_ACT, C_CONSULT]) : (directs ? [ACT, CONSULT, DIRECT] : [ACT, CONSULT]);

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const pred = (name: string): Hex => keccak256(toBytes(name));
const pc = createPublicClient({ transport: http(RPC) });
const profile = CONTRACTS.agentProfileResolver as Address;

// ── the person ──
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
const token: string = si.homeSession; const SIGNED_IN = String(si.agent).toLowerCase() as Address;
if (!token || !SIGNED_IN) throw new Error(`no session for ${handle}: ${JSON.stringify(si).slice(0, 200)}`);
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`); return b.signature; };
const naming = new AgentNamingClient({ rpcUrl: RPC, chainId: 34348, registry: CONTRACTS.agentNameRegistry as Address, universalResolver: CONTRACTS.agentNameUniversalResolver as Address });
// A SERVICE is written by its custodian: the same persona-sign, the service's own SA as the userOp sender —
// its ERC-1271 accepts the custodian's EOA (the charter set it so).
const PERSON_SA = SIGNED_IN;
const SA = otherName ? ((await naming.resolveName(otherName).catch(() => null))?.toLowerCase() as Address | undefined) : PERSON_SA;
if (!SA) throw new Error(`${otherName} does not resolve — charter it first (charter-coach.mts for a coach, charter-cast.mts for a character)`);
const name = otherName ?? ((await naming.reverseResolve(SA)) ?? `${handle}.me`);
console.log(`${name} ${SA}${otherName ? ` (custodied by ${handle}.me ${PERSON_SA})` : ''}`);

// ── 1. atl:capabilities on chain ──
const current = String(await pc.readContract({ address: profile, abi: agentProfileResolverAbi, functionName: 'getStringProperty', args: [SA, pred('atl:capabilities')] }).catch(() => ''));
const have = current.split(',').map((s) => s.trim()).filter(Boolean);
const want = [...have, ...SKILLS.map((s) => s.id).filter((id) => !have.includes(id))];
if (want.length === have.length) console.log(`  · atl:capabilities already carries Mystery Night's skills: ${current}`);
else {
  const csv = want.join(',');
  const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
  const csrf = (await j(csrfRes)) as { token?: string };
  const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
  const callData = buildExecuteBatchCallData([{ to: profile, value: 0n, data: encodeFunctionData({ abi: agentProfileResolverAbi, functionName: 'setStringProperty', args: [SA, pred('atl:capabilities'), csv] }) }]);
  let txHash: string | undefined; let lastErr = '';
  for (let i = 0; i < 4 && !txHash; i++) {
    if (i) await new Promise((r) => setTimeout(r, 3000));
    const b = await j(await fetch(`${HOME}/a2a/account/build-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ sender: SA, callData }) }));
    if (!b.ok || !b.userOpHash) { lastErr = `${b.error ?? ''} ${b.detail ?? JSON.stringify(b).slice(0, 200)}`; continue; }
    const s = await j(await fetch(`${HOME}/a2a/account/submit-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ userOp: { ...b.userOp, signature: await sign(b.userOpHash as Hex) } }) }));
    if (s.ok) txHash = s.transactionHash; else lastErr = `${s.error ?? ''} ${s.detail ?? JSON.stringify(s).slice(0, 200)}`;
  }
  if (!txHash) { console.error(`✗ atl:capabilities did not land: ${lastErr}`); process.exit(1); }
  console.log(`  atl:capabilities ← "${csv}"  tx ${txHash}`);
}

// ── 2. the Studio draft — the HANDLE'S OWN agent only. A service and a persona alike have no Studio card:
// their live card is built from the on-chain profile the step above just wrote, which is why that step is the
// whole job for them and this one would have nothing to patch.
if (otherName) { console.log(`\n✓ ${otherName} advertises ${SKILLS.map((s) => s.id).join(', ')}`); process.exit(0); }
const grant = ((await j(await fetch(`${HOME}/connect/self-grant?purpose=agent-card-studio`, { headers: { authorization: `Bearer ${token}` } }))) as { grant?: Record<string, unknown> & { delegate: string } }).grant;
if (!grant) throw new Error('no stored Studio grant — open the Studio once in the Home to mint it');
const csrfRes2 = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf2 = (await j(csrfRes2)) as { token?: string };
const H2 = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes2.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf2.token ?? '' };
const studio = async <T,>(op: string, args: Record<string, unknown>): Promise<T> => {
  const r = await j(await fetch(`${HOME}/a2a/agent-cards/${op}`, { method: 'POST', headers: H2, body: JSON.stringify({ delegation: grant, requester: grant.delegate, args }) }));
  if (r.ok !== true) throw new Error(`${op}: ${r.error ?? ''} ${r.detail ?? JSON.stringify(r).slice(0, 300)}`);
  return r as T;
};
const { cards } = await studio<{ cards: Array<{ resource: { cardResourceId: string }; servedReleaseId: string | null }> }>('card.list', {});
const cardId = cards[0]?.resource.cardResourceId;
if (!cardId) throw new Error('no card in the Studio — run rebuild-card-release.mts first to create one');
const got = await studio<{ draft: { revision: number; card: { skills?: Array<{ id: string }> } } }>('card.get', { cardResourceId: cardId });
const onCard = new Set((got.draft.card.skills ?? []).map((s) => s.id));
const missing = SKILLS.filter((s) => !onCard.has(s.id));
if (missing.length === 0) console.log(`  · the draft already carries Mystery Night's skills (revision ${got.draft.revision})`);
else {
  const patch = missing.map((s) => ({ op: 'add', path: '/skills/-', value: s }));
  const patched = await studio<{ draft: { revision: number; card: { skills?: Array<{ id: string }> } } }>('card.patchDraft', {
    cardResourceId: cardId, patch, mutation: { idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID(), expectedRevision: got.draft.revision },
  });
  console.log(`  draft revision ${patched.draft.revision}: skills now ${(patched.draft.card.skills ?? []).map((s) => s.id).join(', ')}`);
}
console.log(`\n✓ now release it: npx tsx scripts/rebuild-card-release.mts ${handle} && npx tsx scripts/republish-card-record.mts ${handle}`);
