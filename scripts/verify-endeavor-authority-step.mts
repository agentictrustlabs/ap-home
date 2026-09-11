/**
 * Spec 350 W3 / 334 §6 — a plan step that needs authority becomes work waiting on a person, and is
 * satisfied by a RECEIPT rather than a paragraph.
 *
 *   npx tsx scripts/verify-endeavor-authority-step.mts        (from the repo root)
 *
 * The whole loop, on faithchain: an endeavor whose adopted plan contains a step naming
 * `organization.team.create` → the work turn PARKS it (open, with a note naming the capability, the
 * principal and the run) → a steward claims that run in the Ask and grants the mandate → the step is
 * satisfied with `urn:ap:receipt:run|mandate|tx` refs.
 *
 * What a pass proves that a unit test cannot: the work turn really declines to write prose about it, the
 * checkpoint really survives to be claimed, and the endeavor really ends up holding evidence a reader can
 * check rather than a claim.
 */
import { toHex, type Address, type Hex } from 'viem';
import { buildDigestBindingCaveat, capabilityHandler, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';

const HOME = 'https://www.faithnet.me';
const A2A = 'https://a2a.faithnet.io';
const CHAIN = 34348;
const E = {
  delegationManager: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1',
} as const;
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as Address;   // Missio Nexus — Alice stewards it
const LABEL = `corridor-${Date.now().toString(36).slice(-4)}`;

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 400), _status: r.status }; } };
const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-jp' }) }));
const token: string = signin.homeSession;
if (!token) throw new Error('no session for alice');
const personas = await j(await fetch(`${HOME}/connect/demo-personas`));
const credential = { kind: 'eoa', address: (personas.personas as Array<{ sa: string; custodian: string }>).find((p) => p.sa.toLowerCase() === String(signin.agent).toLowerCase())!.custodian };
const sign = async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`);
  return b.signature;
};
/** The org's stewardship wire — the interactions ops ask for it to prove steward control. */
const related = await j(await fetch(`${HOME}/connect/related-orgs?person=${signin.agent}`, { headers: { authorization: `Bearer ${token}` } }));
const stewardship = (related.orgs ?? []).find((o: { orgAgent: string }) => o.orgAgent.toLowerCase() === ORG)?.stewardshipDelegation;
if (!stewardship) throw new Error('alice holds no stewardship wire for this org');

const ix = async (op: string, payload: Record<string, unknown>) =>
  j(await fetch(`${A2A}/interactions/${ORG}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: token, stewardship, ...payload }) }));

// ── 1. an endeavor with a plan whose step needs authority ──
console.log('── an endeavor whose plan contains an authority-bearing step ──');
// Auto-work is enabled AFTER our plan is adopted, and deliberately: with it on, a request is
// auto-triaged and the assistant drafts and adopts a plan OF ITS OWN — which is the right behaviour and
// the wrong test. `endeavor.adoptPlan` is what dispatches the work turn, so the order is: our plan,
// adopted by us, then auto-work, then adopt again to trigger the run over the plan we wrote.
// An endeavor starts as a REQUEST the steward triages — the coordination model does not let an org
// simply have work; someone asks, and someone adopts (spec 332).
const requested = await ix('endeavor.request', { goal: `Stand up the ${LABEL} corridor`, entryPoint: 'home-request' });
const requestId = requested.requestId ?? requested.request?.requestId;
if (!requestId) throw new Error(`endeavor.request: ${JSON.stringify(requested).slice(0, 300)}`);
// A steward's own request is adopted as it is made (there is nobody to triage it for them), so the
// endeavor id comes back from the request itself; a request from anyone else needs `endeavor.create`.
// The request is triaged into an endeavor, and on an org with auto-work already on that happens BY
// ITSELF, asynchronously — so this polls for the endeavor the request became rather than assuming either
// path. Racing it produced `mcp_500` from a triage that had already run.
const findEndeavor = async (): Promise<string | undefined> => {
  const list = await ix('endeavor.list', {});
  return ((list.endeavors ?? list.rows ?? []) as Array<Record<string, any>>)
    .find((e) => `${e.title ?? ''}${e.goal ?? ''}`.includes(LABEL))?.endeavorId;
};
let endeavorId = await findEndeavor();
if (!endeavorId) {
  await ix('endeavor.create', { requestId, decision: 'adopt' }).catch(() => ({}));
  for (let i = 0; i < 10 && !endeavorId; i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    endeavorId = await findEndeavor();
  }
}
if (!endeavorId) throw new Error(`the request never became an endeavor (${requestId})`);
console.log(`  endeavor ${endeavorId}`);

// The ASSISTANT drafts and adopts the plan — the real path, and the only one that proves the planner can
// NAME an authority-bearing step. (A steward cannot propose a plan here: the reducer admits the managing
// principal or an active participant, and participation needs a plan to join, so proposing our own step
// was a test writing the answer it wanted to check.) Auto-work is on, so requesting was enough.
console.log('  waiting for the assistant to draft and adopt a plan…');

// ── 2. the work turn parks it: the capability step stays OPEN, and the endeavor is told what is owed ──
// The note lands in the endeavor's own conversation (`conv_<endeavorId>`), which is where a person
// working the endeavor would see it — not in the plan projection.
const stepOf = (s: Record<string, any>) => (s.plan?.steps ?? []).find((x: { capabilityRequirements?: Array<{ capabilityIri: string }> }) =>
  (x.capabilityRequirements ?? []).some((c) => c.capabilityIri.includes('organization.')));
let runRef = '';
let state: Record<string, any> = {};
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 8_000));
  state = await ix('endeavor.get', { endeavorId });
  // `channels.read` returns every channel with the named one's messages inflated, and the BODIES
  // separately (they live at each envelope's own resource).
  const thread = await ix('channels.read', { channelId: `conv_${endeavorId}` });
  const note = Object.values((thread.bodies ?? {}) as Record<string, unknown>)
    .map((b) => (typeof b === 'string' ? b : JSON.stringify(b)))
    .find((b) => b.includes('needs authority nobody has granted'));
  if (note) { runRef = /`(run-[a-z0-9-]+)`/.exec(note)?.[1] ?? ''; console.log(`  parked: ${note.split('\n')[0]}`); break; }
  const st = stepOf(state);
  if (i % 3 === 2) console.log(`  …plan ${state.endeavor?.stepsSatisfied ?? '?'}/${state.endeavor?.stepsTotal ?? '?'} satisfied; capability step ${st?.stepId ?? '(none yet)'} satisfied=${st?.satisfied}`);
}
const parked = stepOf(state);
if (!parked) throw new Error('the assistant drafted no authority-bearing step — the planner cannot name one');
console.log(`  step ${parked.stepId} (${parked.capabilityRequirements?.[0]?.capabilityIri}) satisfied=${parked.satisfied}`);
if (parked.satisfied) throw new Error('an authority-bearing step was satisfied without authority');
if (!runRef) throw new Error('the step is open, but the endeavor was never told what it is waiting for');

// ── 3. a steward claims the run in the Ask and grants the mandate ──
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const post = async (body: unknown) =>
  j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify(body) }));
async function mint(reply: { requirement: MandateRequirementV1; delegate: Address; delegator: Address }) {
  const caveats: Caveat[] = [...capabilityHandler.toCaveats(reply.requirement, E as never), buildDigestBindingCaveat(E.digestBinding, 'intent', reply.requirement.intentDigest as Hex)];
  const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
  const d: Delegation = { delegator: reply.delegator, delegate: reply.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  d.signature = await sign(hashDelegation(d, CHAIN, E.delegationManager));
  return { ...d, salt: salt.toString() };
}
console.log(`\n── a steward claims ${runRef} in the Ask ──`);
let r = await post({ session: token, addressee: ORG, runRef });
let presented: unknown = null;
for (let turn = 0; turn < 6 && r.reply?.kind !== 'done'; turn++) {
  const reply = r.reply;
  if (!reply) throw new Error(`no reply: ${JSON.stringify(r).slice(0, 400)}`);
  console.log(`  ${reply.kind}${reply.kind === 'prompt' ? `: "${reply.prompt.prompt.slice(0, 62)}"` : reply.kind === 'authority_required' ? ` (${reply.capability})` : reply.kind === 'refused' ? ` — ${reply.error}` : ''}`);
  if (reply.kind === 'refused') throw new Error(`the claimed run was refused: ${reply.error}`);
  // An `answer` here means the harness read something instead of acting — the hand-off failed to say
  // which capability the step was adopted as.
  if (reply.kind === 'answer') throw new Error(`the claimed run ANSWERED instead of acting: ${String(reply.text).slice(0, 200)}`);
  const supplied: unknown[] = [];
  if (reply.kind === 'authority_required') presented = await mint(reply);
  else if (reply.prompt.kind === 'data') {
    const fields = reply.prompt.fields as Array<{ name: string; type: string }>;
    supplied.push({ stepRef: reply.resumeToken, data: Object.fromEntries(fields.map((f) => [f.name, f.type === 'credential' ? credential : LABEL])) });
  } else if (reply.prompt.kind === 'signature') {
    supplied.push({ stepRef: reply.resumeToken, signature: { digest: reply.prompt.digest, signer: reply.prompt.signer, signature: await sign(reply.prompt.digest), payload: reply.prompt.payload } });
  }
  r = await post({ session: token, addressee: ORG, runRef, ...(presented ? { presented } : {}), supplied });
  presented = null;
}
if (r.reply?.kind !== 'done') throw new Error(`the claimed run did not finish: ${JSON.stringify(r).slice(0, 500)}`);
console.log(`  done: ${r.reply.result.name} at ${r.reply.result.agent}`);
console.log(`  step recorded: ${JSON.stringify(r.satisfiedStep ?? null)}`);
if (!r.satisfiedStep?.ok) throw new Error(`the capability ran but the step was not recorded: ${JSON.stringify(r.satisfiedStep ?? 'no origin on the run')}`);

// ── 4. the step is satisfied — with a receipt, not a claim ──
const after = await ix('endeavor.get', { endeavorId });
const done = stepOf(after);
const evidence = JSON.stringify(done?.evidenceRefs ?? done?.evidence ?? after.plan?.steps ?? []);
console.log(`\n  step satisfied=${done?.satisfied}`);
console.log(`  evidence: ${evidence.slice(0, 260)}`);
if (!done?.satisfied) throw new Error('the step was not satisfied after its capability ran');
if (!/urn:ap:receipt:run:/.test(evidence)) throw new Error('the step carries no receipt — evidence must be checkable, not a claim');
console.log('\n✓ an authority-bearing step: parked open with what it needs, claimed by a steward, and satisfied by a receipt.');
