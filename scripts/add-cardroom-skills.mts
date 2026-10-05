/**
 * PUT THE CARD ROOM'S SKILLS ON AN AGENT'S CARD — the Home acts a card room cannot do.
 *
 *   npx tsx scripts/add-cardroom-skills.mts <handle>                       (a PERSON's own agent: advise, record, review)
 *   npx tsx scripts/add-cardroom-skills.mts --service bob-coach.svc --by bob (a COACH service: advise, review)
 *   then, for a person: npx tsx scripts/rebuild-card-release.mts <handle> && npx tsx scripts/republish-card-record.mts <handle>
 *
 * A card room (poker.faithnet.io) refuses to name an agent as somebody's adviser unless the agent's card
 * advertises the game's advise skill — checked once, by name, so nobody discovers mid-hand that their
 * adviser cannot answer. A person's own agent carries the Home's skills and not these, so it is refused
 * BY NAME until they are added. Two things add them, and both are custodial acts a person does for their
 * own agent — done here the way the demo estate does every such act, with the persona's own session and
 * `persona-sign`, the same signature the person's own click would make:
 *
 *   1. `atl:capabilities` on the agent's SA profile gains the ids. That is what the LIVE card is built from
 *      (`skillsFromLabels`), what discovery ranks on, and what the Home's harness reads to decide which
 *      skills an agent ANSWERS (`readAdvertisedCapabilityIds`). One sponsored userOp from the SA.
 *   2. For a person, the Studio DRAFT gains the same skills, because a release is cut from the draft, not
 *      re-read from chain. `rebuild-card-release.mts` then releases, signs, publishes.
 *
 * WHO ADVERTISES WHAT (`apps/agent-runtime/src/card-room.ts`). A PERSON's agent advertises `poker.advise`,
 * `poker.record` and `poker.review` (and canasta's) because the table addresses it — and answers none of
 * them with a model: it consults the coach its playbook names, records the hand into her vault, forwards a
 * review. A COACH SERVICE advertises `poker.advise` and `poker.review` because the person's agent consults
 * it for exactly those. `poker.act` is on neither: a coach never takes a turn. A coach's PERSON (bob.me)
 * advertises no card-room skill at all.
 *
 * IT GRANTS NOTHING. A skill on a card says the agent answers that question; the card room's questions
 * carry only what the person's own seat already sees, and no reply is ever applied to a table.
 */
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { buildExecuteBatchCallData } from '@agenticprimitives/agent-account';
import { agentProfileResolverAbi } from '@agenticprimitives/agent-profile';
import { CONTRACTS } from '@agenticprimitives/contracts/deployments/faithchain';
import { createPublicClient, encodeFunctionData, http, keccak256, toBytes, type Address, type Hex } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const argv = process.argv.slice(2);
const serviceName = argv.includes('--service') ? argv[argv.indexOf('--service') + 1] : undefined;
const handle = serviceName ? (argv.includes('--by') ? argv[argv.indexOf('--by') + 1] : undefined) : argv[0];
/** Which game a SERVICE coaches — `poker` (the default) or `canasta`. A person's agent gets both games' skills. */
const game = argv.includes('--game') ? String(argv[argv.indexOf('--game') + 1]).toLowerCase() : 'poker';
if (!handle || (serviceName && !/\.svc$/.test(serviceName)) || !['poker', 'canasta'].includes(game)) throw new Error('usage: add-cardroom-skills.mts <handle> | --service <name.svc> --by <custodian handle> [--game poker|canasta]');

/** The card room's skills, spelled exactly as `@pokernight/protocol` spells them and as the card room checks. */
const PERSON_SKILLS = [
  { id: 'poker.advise', name: "Hold'em advice", description: 'Say what the person in a seat should do at Texas Hold’em, and why — consulted from the coaching service this agent’s playbook names, under the person’s study grant. Advice only: nothing here takes a turn. Input is the seat’s own redacted view and legal moves; output is one JSON object {say, because, action?, source}.', tags: ['poker.advise', 'poker', 'advice', 'coach', 'pokernight'] },
  { id: 'canasta.advise', name: 'Canasta advice', description: 'Say what the person in a seat should do at Classic Canasta, and why — consulted from the coaching service this agent’s playbook names. Advice only. Output is one JSON object {say, because, action?, source}.', tags: ['canasta.advise', 'canasta', 'advice', 'coach', 'pokernight'] },
  { id: 'poker.record', name: "Hold'em hand record", description: 'Receive a finished hand as one seat saw it, with the table’s counts per player, and put it into the person’s own vault (cardroom.hand). A vault put: no model, no answer acted on.', tags: ['poker.record', 'poker', 'record', 'pokernight'] },
  { id: 'canasta.record', name: 'Canasta round record', description: 'Receive a finished round as one seat saw it, with the table’s counts, and put it into the person’s own vault under canasta’s own record names. A vault put: no model.', tags: ['canasta.record', 'canasta', 'record', 'pokernight'] },
  { id: 'canasta.review', name: 'Canasta review', description: 'When the person asks how they have been playing canasta, forward the question to the coaching service their playbook names, with their study grant; the coach reviews their recorded rounds and answers in its own name.', tags: ['canasta.review', 'canasta', 'review', 'coach', 'pokernight'] },
  { id: 'canasta.coach', name: 'Who coaches me at canasta', description: 'Answer the card room: which coaching service this agent consults for canasta, and whether the person has been asked about hiring one; record the person’s answer in their own vault so they are asked once. No model.', tags: ['canasta.coach', 'canasta', 'coach', 'pokernight'] },
  { id: 'poker.review', name: "Hold'em review", description: 'When the person asks how they have been playing, forward the question to the coaching service their playbook names, with their study grant; the coach reviews their recorded hands and answers in its own name.', tags: ['poker.review', 'poker', 'review', 'coach', 'pokernight'] },
  { id: 'poker.coach', name: 'Who coaches me', description: 'Answer the card room: which coaching service this agent consults, and whether the person has been asked about hiring one; record the person’s answer in their own vault so they are asked once. No model.', tags: ['poker.coach', 'poker', 'coach', 'pokernight'] },
];
const SERVICE_SKILLS = game === 'canasta' ? [
  { id: 'canasta.advise', name: 'Canasta coaching', description: 'Advise one person at Classic Canasta through that person’s own agent, from that person’s own records under a study grant they signed. Consulted on a turn by their agent, never by the table; answers {say, because, action?} in the coach’s name. Never takes a turn, never a partner.', tags: ['canasta.advise', 'canasta', 'coach', 'canasta-coach', 'pokernight'] },
  { id: 'canasta.review', name: 'Canasta round review', description: 'Review one person’s recorded rounds when they ask, under their study grant: what happened, the decisions that mattered, the leak with its count in points, one change; the partnership as counts, never blame. Writes one note back into their vault.', tags: ['canasta.review', 'canasta', 'review', 'coach', 'canasta-coach', 'pokernight'] },
] : [
  { id: 'poker.advise', name: "Hold'em coaching", description: 'Advise one person at Texas Hold’em through that person’s own agent, from that person’s own records under a study grant she signed. Consulted mid-hand by her agent, never by the table; answers {say, because, action?} in the coach’s name. Never takes a turn.', tags: ['poker.advise', 'poker', 'coach', 'holdem-coach', 'pokernight'] },
  { id: 'poker.review', name: "Hold'em hand review", description: 'Review one person’s recorded hands when she asks, under her study grant: what happened, the decisions that mattered, the leak with its count, one change. Writes one note back into her vault.', tags: ['poker.review', 'poker', 'review', 'coach', 'holdem-coach', 'pokernight'] },
];
const SKILLS = serviceName ? SERVICE_SKILLS : PERSON_SKILLS;

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
const SA = serviceName ? ((await naming.resolveName(serviceName).catch(() => null))?.toLowerCase() as Address | undefined) : PERSON_SA;
if (!SA) throw new Error(`${serviceName} does not resolve — charter it first (scripts/charter-coach.mts)`);
const name = serviceName ?? ((await naming.reverseResolve(SA)) ?? `${handle}.me`);
console.log(`${name} ${SA}${serviceName ? ` (custodied by ${handle}.me ${PERSON_SA})` : ''}`);

// ── 1. atl:capabilities on chain ──
const current = String(await pc.readContract({ address: profile, abi: agentProfileResolverAbi, functionName: 'getStringProperty', args: [SA, pred('atl:capabilities')] }).catch(() => ''));
const have = current.split(',').map((s) => s.trim()).filter(Boolean);
const want = [...have, ...SKILLS.map((s) => s.id).filter((id) => !have.includes(id))];
if (want.length === have.length) console.log(`  · atl:capabilities already carries the card room's skills: ${current}`);
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

// ── 2. the Studio draft (a person's; a service has no Studio card — its live card is built from the profile) ──
if (serviceName) { console.log(`\n✓ ${serviceName} advertises ${SKILLS.map((s) => s.id).join(', ')}`); process.exit(0); }
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
if (missing.length === 0) console.log(`  · the draft already carries the card room's skills (revision ${got.draft.revision})`);
else {
  const patch = missing.map((s) => ({ op: 'add', path: '/skills/-', value: s }));
  const patched = await studio<{ draft: { revision: number; card: { skills?: Array<{ id: string }> } } }>('card.patchDraft', {
    cardResourceId: cardId, patch, mutation: { idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID(), expectedRevision: got.draft.revision },
  });
  console.log(`  draft revision ${patched.draft.revision}: skills now ${(patched.draft.card.skills ?? []).map((s) => s.id).join(', ')}`);
}
console.log(`\n✓ now release it: npx tsx scripts/rebuild-card-release.mts ${handle} && npx tsx scripts/republish-card-record.mts ${handle}`);
