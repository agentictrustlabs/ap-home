/**
 * Spec 374 W2 — THE STEWARD SHAPE, live: alice, at HER OWN agent, asks it to invite someone to Missio
 * Nexus, an organization she stewards. The act routes to missio-nexus.org; the organization asks for ITS
 * mandate; because alice stewards it (the wire she presented was verified there), that request is relayed
 * to her as her own authority request — delegator = the organization — and she grants it at home with her
 * own credential, as the organization's custodian. Her resume carries the mandate to the organization's
 * parked run, which finishes under its own gates. One ask, one mandate, the organization's receipt.
 *
 *   npx tsx scripts/verify-routed-write-steward.mts [invitee]
 */
import { hashDelegation, buildDigestBindingCaveat, capabilityHandler, ROOT_AUTHORITY, type Delegation, type Caveat, type MandateRequirementV1 } from '../packages/delegation/src/index.js';
import type { Address, Hex } from 'viem';

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = {
  delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE',
  digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1',
} as const;
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as Address;   // missio-nexus.org
const INVITEE = process.argv[2] ?? 'dave.me';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const ALICE = String(alice.agent).toLowerCase() as Address;
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
let signCount = 0;
const sign = async (digest: Hex): Promise<Hex> => {
  signCount += 1;
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.homeSession}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 150)}`);
  return b.signature;
};

console.log('── alice, at her own agent, invites someone to Missio Nexus (which she stewards) ──');
const ask = `invite ${INVITEE} to Missio Nexus`;
const r1 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, message: ask });
const rep = r1.reply as { kind?: string; error?: string; text?: string; runRef?: string; stepRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex; purpose: string }>; routedAt?: { agent: string; name?: string; runRef: string }; standing?: { relation?: string } } | undefined;
console.log(`  alice's agent → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.text ? ` ${JSON.stringify(rep.text).slice(0, 120)}` : ''}${rep?.delegator ? ` (delegator ${rep.delegator.slice(0, 10)}…, standing ${rep.standing?.relation ?? '?'})` : ''}`);
if (rep?.kind !== 'authority_required' || !rep.requirement || !rep.delegator || !rep.delegate) throw new Error(`expected the organization's authority request relayed as alice's own: ${JSON.stringify(r1).slice(0, 700)}`);
if (rep.delegator.toLowerCase() !== ORG) throw new Error(`the mandate asked is not the organization's (delegator ${rep.delegator})`);
if (!rep.routedAt || rep.routedAt.agent.toLowerCase() !== ORG) throw new Error('the reply does not say the step waits at missio-nexus.org');
console.log(`  relayed: the organization's own request — waits at ${rep.routedAt.name ?? rep.routedAt.agent} as ${rep.routedAt.runRef}`);

const runs = ((await post('/harness/runs', { session: alice.homeSession, addressee: ALICE })) as { runs?: Array<{ runRef: string; routedAt?: unknown; awaiting?: unknown }> }).runs ?? [];
const mine = runs.find((r) => r.runRef === rep.runRef);
console.log(`  checkpoint: ${mine ? `routedAt ${JSON.stringify(mine.routedAt)} awaiting ${JSON.stringify(mine.awaiting)}` : 'not listed'}`);
// She grants it as the organization's custodian, the way the Home does for any org mandate.
const req = rep.requirement;
const caveats: Caveat[] = [...capabilityHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req.intentDigest as Hex)];
let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
const digests = [hashDelegation(mandate, CHAIN, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)];
const a = await post('/harness/authorize', { session: alice.homeSession, delegator: rep.delegator, digests });
if (a.ok !== true) throw new Error(`authorize build failed: ${JSON.stringify(a).slice(0, 300)}`);
const b2 = await post('/harness/authorize', { session: alice.homeSession, delegator: rep.delegator, userOp: a.userOp, signature: await sign(a.userOpHash as Hex) });
if (b2.ok !== true) throw new Error(`authorize submit failed: ${JSON.stringify(b2).slice(0, 300)}`);
mandate.signature = '0x03';
console.log(`  alice approved the organization's mandate on chain (tx ${String(b2.txHash).slice(0, 18)}…)`);

// The resume at HER agent carries the mandate to the organization's parked run.
let fin = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
let rp = fin.reply as { kind?: string; error?: string; text?: string; prompt?: { kind?: string; stepRef?: string; digest?: Hex; signer?: string; prompt?: string }; routed?: Array<{ agent: string; name?: string; observedVia: string; runRef?: string; receipts?: number }> } | undefined;
if (rp?.kind === 'prompt' && rp.prompt?.kind === 'signature' && rp.prompt.digest) {
  const supplied = [{ stepRef: rp.prompt.stepRef ?? 's0', signature: { digest: rp.prompt.digest, signer: ALICE, signature: await sign(rp.prompt.digest) } }];
  fin = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, runRef: rep.runRef, supplied });
  rp = fin.reply;
}
console.log(`  alice's agent → ${rp?.kind}${rp?.error ? ` ${rp.error}` : ''}${rp?.text ? ` ${JSON.stringify(rp.text).slice(0, 160)}` : ''}${(rp as { routedAt?: unknown })?.routedAt ? ` routedAt ${JSON.stringify((rp as { routedAt?: unknown }).routedAt)}` : ' (local authority request)'}${(rp as { summary?: string })?.summary ? ` — ${(rp as { summary?: string }).summary}` : ''}`);
if (rp?.kind !== 'done' && rp?.kind !== 'answer') throw new Error(`expected the act to finish through the continuation: ${JSON.stringify(fin).slice(0, 700)}`);
const via = (rp.routed ?? [])[0];
console.log(`  done by ${via?.name ?? via?.agent ?? 'the subject'} (${via?.observedVia ?? '?'}${via?.runRef ? `, run ${via.runRef.slice(0, 18)}…` : ''})  ·  signatures used: ${signCount}`);
if (signCount !== 1) throw new Error(`one ask, one signature — it cost ${signCount}`);
console.log(`\n✓ spec 374 W2: the organization's own authority request was relayed to its steward at her own agent; she granted it as the organization's custodian, the mandate travelled to the organization's parked run, and the act finished there. Her agent relayed and never signed.`);
