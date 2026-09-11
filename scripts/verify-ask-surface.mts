/**
 * Spec 350 §3.5/§3.6 — THE ASK, end to end on faithchain, exactly as the Home's flyout drives it.
 *
 *   npx tsx scripts/verify-ask-surface.mts            (from the repo root)
 *
 * Plays the surface for Alice: type a sentence at the agent whose realm you are standing in, and answer
 * what comes back. Nothing here knows how to create a team — it knows how to answer four kinds of reply:
 *
 *   authority_required → mint the mandate the agent said it needs, signed by the credential that
 *                        custodies the DELEGATOR (the parent), and come back with it
 *   prompt (data)      → a `credential` field is answered by the SURFACE (the connected credential);
 *                        anything else would be typed by the person
 *   prompt (signature) → the connected credential signs the genesis the agent derived
 *   done               → it happened
 *
 * Two scenarios, one script: a TEAM in a workspace's realm, and an ORGANIZATION in the person's own realm
 * — the same ceremony, differing only in whose authority it needs. Plus the twin that matters: the ask
 * refuses to act under a mandate minted for a different sentence.
 */
import { createPublicClient, http, toHex, type Address, type Hex } from 'viem';
import {
  buildDigestBindingCaveat, capabilityHandler, hashDelegation, ROOT_AUTHORITY,
  type Caveat, type Delegation, type MandateRequirementV1,
} from '@agenticprimitives/delegation';

const HOME = 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const CHAIN = 34348;
const E = {
  delegationManager: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1',
} as const;
const WORKSPACE = '0xee11DFB02e4a02630bE512886305DF5C68Fd682c'.toLowerCase() as Address; // alicefield.impact — Alice's key custodies it
const SUFFIX = Date.now().toString(36).slice(-4);

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 400), _status: r.status }; } };
const pub = createPublicClient({ transport: http(RPC) });

// ── the session + the connected credential (what the surface knows about itself) ──
const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-jp' }) }));
const token: string = signin.homeSession;
if (!token) throw new Error('no session for alice');
const person = String(signin.agent).toLowerCase() as Address;
const personas = await j(await fetch(`${HOME}/connect/demo-personas`));
const credentialEoa = (personas.personas as Array<{ sa: string; custodian: string }>).find((p) => p.sa.toLowerCase() === person)?.custodian as Address;
const credential = { kind: 'eoa', address: credentialEoa };
const sign = async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`);
  return b.signature;
};
console.log(`alice ${person}  connected credential ${credentialEoa}`);

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const post = async (body: unknown) =>
  j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify(body) }));

/** What the flyout's "Grant & continue" does: build the caveats HERE from the requirement (never accept
 *  them from the server), sign as the delegator's custodian. */
async function mintMandate(reply: { requirement: MandateRequirementV1; delegate: Address; delegator: Address }) {
  const caveats: Caveat[] = [
    ...capabilityHandler.toCaveats(reply.requirement, E as never),
    buildDigestBindingCaveat(E.digestBinding, 'intent', reply.requirement.intentDigest as Hex),
  ];
  const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
  const d: Delegation = { delegator: reply.delegator, delegate: reply.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  d.signature = await sign(hashDelegation(d, CHAIN, E.delegationManager));
  return { ...d, salt: salt.toString() };
}

/** The panel's turn loop, in ~20 lines: send, render, answer what we can, repeat. */
async function askUntilDone(message: string, addressee: Address, opts: { presented?: unknown } = {}) {
  const runRef = `ask-${Date.now().toString(36)}`;
  const supplied: unknown[] = [];
  let presented: unknown = opts.presented ?? null;
  for (let turn = 0; turn < 6; turn++) {
    const res = await post({ session: token, addressee, message, runRef, presented, supplied });
    const reply = res.reply;
    if (!reply) throw new Error(`no reply: ${JSON.stringify(res).slice(0, 400)}`);
    console.log(`  ← ${reply.kind}${reply.kind === 'authority_required' ? ` (${reply.capability} as ${reply.delegator.slice(0, 10)}…)` : ''}${reply.kind === 'prompt' ? `: "${reply.prompt.prompt}"` : ''}${reply.kind === 'refused' ? ` — ${reply.error}` : ''}`);
    if (reply.kind === 'done' || reply.kind === 'answer' || reply.kind === 'refused') return reply;
    if (reply.kind === 'authority_required') {
      if (opts.presented) return reply; // a caller testing a wrong mandate does not get a second chance
      presented = await mintMandate(reply);
      console.log(`  → granted: ${reply.capability}, for this ask only`);
      continue;
    }
    if (reply.prompt.kind === 'data') {
      const data: Record<string, unknown> = {};
      for (const f of reply.prompt.fields) {
        if (f.type === 'credential') { data[f.name] = credential; console.log(`  → ${f.name}: the connected credential (nobody was asked)`); }
        else throw new Error(`the person would be asked for "${f.name}" here — this ask should not have needed that`);
      }
      supplied.push({ stepRef: reply.resumeToken, data });
    } else if (reply.prompt.kind === 'signature') {
      console.log(`  → signing the genesis: ${reply.prompt.digest.slice(0, 18)}… by ${reply.prompt.signer.slice(0, 10)}…`);
      supplied.push({ stepRef: reply.resumeToken, signature: { digest: reply.prompt.digest, signer: reply.prompt.signer, signature: await sign(reply.prompt.digest), payload: reply.prompt.payload } });
    } else {
      supplied.push({ stepRef: reply.resumeToken, confirmed: true });
    }
  }
  throw new Error('the ask never settled');
}

const onChain = async (label: string, r: { agent: Address; name: string }) => {
  const code = await pub.getBytecode({ address: r.agent });
  const custodied = await pub.readContract({ address: r.agent, abi: [{ type: 'function', name: 'isCustodian', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] }], functionName: 'isCustodian', args: [credentialEoa] });
  console.log(`  ${label}: ${r.name} at ${r.agent} — code ${code && code !== '0x' ? '✓' : '✗'}, custodied by you ${custodied ? '✓' : '✗'}`);
  if (!code || code === '0x' || !custodied) throw new Error(`${label} is not what the ask claimed`);
};

// ── standing in the WORKSPACE: "create a team" ──
console.log(`\n── standing in ${WORKSPACE} (a workspace) ──\n  → "create a team called field-${SUFFIX}"`);
const team = await askUntilDone(`create a team called field-${SUFFIX}`, WORKSPACE);
if (team.kind !== 'done') throw new Error(`expected done: ${JSON.stringify(team).slice(0, 400)}`);
await onChain('team', team.result);

// ── standing in YOUR OWN realm: "create an organization" — the same ceremony, the person's authority ──
console.log(`\n── standing in ${person} (you) ──\n  → "create an organization called mission-${SUFFIX}"`);
const org = await askUntilDone(`create an organization called mission-${SUFFIX}`, person);
if (org.kind !== 'done') throw new Error(`expected done: ${JSON.stringify(org).slice(0, 400)}`);
await onChain('organization', org.result);

// ── the twin: a mandate minted for one sentence does not cover another ──
console.log('\n── the twin: the mandate from the first ask, presented for a different one ──');
const stolen = await post({ session: token, addressee: WORKSPACE, message: `create a team called other-${SUFFIX}`, runRef: 'twin', presented: null });
const need = stolen.reply;
if (need?.kind !== 'authority_required') throw new Error('expected the twin to need authority');
const wrong = await mintMandate({ ...need, requirement: { ...need.requirement, intentDigest: `0x${'11'.repeat(32)}` } });
const refused = await post({ session: token, addressee: WORKSPACE, message: `create a team called other-${SUFFIX}`, runRef: 'twin', presented: wrong, supplied: [] });
console.log(`  ← ${refused.reply?.kind} — ${(refused.reply?.error ?? '').slice(0, 90)}`);
if (refused.reply?.kind !== 'refused' || !/intent-mismatch/.test(refused.reply.error ?? '')) throw new Error('a mandate for another ask must be refused');

console.log(`\n✓ The Ask: ask → the agent names the authority it needs → you grant it for THAT ask → it asks you for what it lacks → it acts. Team and organization both live; a mandate for another sentence refused.`);
