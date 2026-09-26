/**
 * verify-variant-knob — spec 415 A4. THE VARIANT KNOB ON /harness/ask, AND ITS TWINS.
 *
 *   1. `GET /harness/comparison` says this is a comparison estate (EVAL_CAPTURE=on) and what the knob knows.
 *   2. The twin that matters: an OUTSIDER asking the steward's org with a variant is refused `variant.not-steward` —
 *      and so is a member who is not its steward. Standing is derived; the body's say-so is nothing.
 *   3. An unknown component (`temperature`) and an unknown toggle are refused by name (400), never ignored.
 *   4. The steward asks their OWN agent with `retrieval/kb: off` and `plannerKind: rule-based`: the run answers, and its
 *      PROV graph's Variant says what ran — the toggle, and the rule-based planner — with the requested starting state.
 *   5. The measurements are readable beside the graph (`format: 'measures'`) once the export lands.
 *
 * Nothing here is authority: the knob changes how the agent BEHAVES on a test estate; every gate is unchanged.
 */
import { fixture as fx, HOME } from './fixture.mts';

const APEXEC = 'https://agenticprimitives.dev/ns/execution#';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };

const signIn = async (handle: string) => {
  const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
  if (!si.homeSession) fail(`no session for ${handle}`);
  return { token: String(si.homeSession), agent: String(si.agent).toLowerCase() };
};
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = await j(csrfRes);
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => { const r = await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }); return { status: r.status, body: await j(r) }; };

// ── 1. the estate ──
const cmp = await j(await fetch(`${HOME}/a2a/harness/comparison`));
console.log(`── /harness/comparison ── evalCapture=${cmp.evalCapture} · plannerKinds ${JSON.stringify(cmp.plannerKinds)} · toggles ${JSON.stringify(cmp.toggles)}`);
if (cmp.evalCapture !== 'on') fail('this estate does not run comparisons (EVAL_CAPTURE is not on) — the knob cannot be exercised here');

const steward = await signIn(fx.people.steward);
const outsider = await signIn(fx.people.outsider);
const member = await signIn(fx.people.member);
const org = String(fx.org.agent ?? '').toLowerCase();
if (!org) fail('the fixture names no org agent');

// ── 2. the twins: standing ──
const asOutsider = await post('/harness/ask', { session: outsider.token, addressee: org, message: 'who are the members?', variant: { toggles: { 'retrieval/kb': 'off' } } });
console.log(`\n── outsider (${fx.people.outsider}) → ${fx.org.handle} with a variant ── ${asOutsider.status} ${asOutsider.body.refused ?? ''}`);
if (asOutsider.status !== 403 || asOutsider.body.refused !== 'variant.not-steward') fail(`an outsider's variant was not refused as variant.not-steward: ${JSON.stringify(asOutsider.body).slice(0, 200)}`);
const asMember = await post('/harness/ask', { session: member.token, addressee: org, message: 'who are the members?', variant: { plannerKind: 'rule-based' } });
console.log(`── member (${fx.people.member}) → ${fx.org.handle} with a variant ── ${asMember.status} ${asMember.body.refused ?? ''}`);
if (asMember.status !== 403 || asMember.body.refused !== 'variant.not-steward') fail(`a non-steward member's variant was not refused: ${JSON.stringify(asMember.body).slice(0, 200)}`);

// ── 3. the twins: unknown components ──
for (const [what, variant] of [['an unknown component', { temperature: 0.2 }], ['an unknown toggle', { toggles: { 'memory/facts': 'off' } }], ['a bad value', { plannerKind: 'compiled' }]] as const) {
  const r = await post('/harness/ask', { session: steward.token, addressee: steward.agent, message: 'which organizations am I part of?', variant });
  console.log(`── ${what} ── ${r.status} ${r.body.refused ?? ''}: ${String(r.body.error ?? '').slice(0, 120)}`);
  if (r.status !== 400 || r.body.refused !== 'variant.unknown') fail(`${what} was not refused by name: ${JSON.stringify(r.body).slice(0, 200)}`);
}

// ── 4. the steward's own agent, one thing changed — and the graph says so ──
const t0 = Date.now();
const runRef = `vk-${Date.now().toString(36)}`;
// An ask NO COMPILED SHAPE claims: a compiled plan is decided before any planner runs (spec 355), so only an ask that reaches
// the planner can show which planner the knob chose.
const ok = await post('/harness/ask', { session: steward.token, addressee: steward.agent, message: 'what can you help me with today?', runRef, variant: { plannerKind: 'rule-based', toggles: { 'retrieval/kb': 'off' }, startingState: { domain: 'gate', scenarioId: 'live', digest: `sha256:${'ab'.repeat(32)}` } } });
const reply = ok.body.reply ?? ok.body;
console.log(`\n── steward → own agent under { rule-based, retrieval/kb off } ── ${ok.status} · ${((Date.now() - t0) / 1000).toFixed(1)}s · reply ${String(reply?.kind ?? '?')} · run ${ok.body.hasProvenance?.recordType ?? '?'}`);
if (ok.status !== 200 || !ok.body.hasProvenance?.recordType) fail(`the variant run did not answer with its provenance: ${JSON.stringify(ok.body).slice(0, 300)}`);
const ref = String(ok.body.hasProvenance.recordType).replace(/^run\.provenance:/, '');
await new Promise((r) => setTimeout(r, 2000));
const prov = await post('/harness/provenance', { session: steward.token, addressee: steward.agent, runRef: ref });
const nodes = (prov.body.provenance?.graph ?? []) as Array<Record<string, unknown>>;
const node = (id: unknown) => nodes.find((n) => n['id'] === id);
const run = nodes.find((n) => Array.isArray(n['type']) && (n['type'] as string[]).includes('ServiceExecution'));
if (!run) fail('the graph has no run activity');
const variant = node(run!['underVariant']);
const starting = node(run!['fromStartingState']);
console.log(`── the Variant ── ${JSON.stringify(variant ?? null)}\n── the StartingState ── ${JSON.stringify(starting ?? null)}`);
if (!variant) fail('the run names no Variant');
if (String(variant['plannerKind']) !== 'rule-based') fail(`the Variant's plannerKind is ${String(variant['plannerKind'])}, not rule-based — the knob did not reach the planner`);
const toggles = ([] as string[]).concat((variant['capabilityToggle'] as string[] | string | undefined) ?? []);
if (!toggles.includes('retrieval/kb=off')) fail(`the Variant does not say retrieval/kb is off: ${JSON.stringify(variant)}`);
if (!starting || starting['startingStateDigest'] !== `sha256:${'ab'.repeat(32)}`) fail(`the run does not name its starting state by digest: ${JSON.stringify(starting ?? null)}`);
const kbTool = nodes.some((n) => String(n['realizesCapability'] ?? '').includes('kb.retrieve'));
if (kbTool) fail('retrieval/kb was toggled off and a kb.retrieve step still ran');
const engaged = (run!['hasEngagement'] as Array<Record<string, unknown>> | undefined) ?? [];
const selection = engaged.find((e) => String(e['ofCapability']).startsWith(`${APEXEC}hc-skillSelection`));
console.log(`── skill-selection engagement ── ${selection ? String(selection['ofCapability']).replace(APEXEC, '') : 'none (a compiled or supplied plan selects nothing)'}`);

// ── 5. the measurements beside the graph ──
let measures: Record<string, unknown> | null = null;
for (let i = 0; i < 12 && !measures; i++) {
  const m = await post('/harness/provenance', { session: steward.token, addressee: steward.agent, runRef: ref, format: 'measures' });
  if (m.body.ok && m.body.measures) measures = m.body.measures as Record<string, unknown>;
  else await new Promise((r) => setTimeout(r, 3000));
}
const count = measures ? (((measures['hasMeasurement'] as string[] | undefined) ?? []).length) : 0;
console.log(`── measures ── ${measures ? `${count} measurement(s) read back by format=measures` : 'not readable (the export did not land)'}`);
if (!measures || !count) fail('the run\'s measurements could not be read beside its graph');

console.log(`\n✓ spec 415 A4: the variant knob runs one thing differently for the agent's own steward on a comparison estate, the graph says what ran, and every other request is refused by name.`);
