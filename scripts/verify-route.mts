/**
 * Spec 388 — WHICH MODEL CARRIED EACH CALL, and why, on one live ask through the Home's own boundary: a person's
 * question of the public directory (kb.question → a structured call that writes the query) planned, answered and
 * composed under ORCHESTRATION_ROUTE=budget. Prints `plannerTrace.route` — planner, structured calls, composer —
 * with the numbers each decision was judged by.
 *
 *   npx tsx scripts/verify-route.mts        (one live ask; HANDLE=… ASK=… to vary)
 */
import { fixture as fx, HOME } from './fixture.mts';
const HANDLE = fx.people.steward;
const ASK = process.env.ASK ?? 'how many organizations are in the public directory, and name three';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: HANDLE, client_id: 'demo-web' }) }));
if (!si.homeSession) fail(`no session for ${HANDLE}`);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
type Decision = { provider: string | null; because: string; considered: Array<{ provider: string; budget: number | null; spentThisMinute?: number; fits: boolean }> };
type Reply = { kind: string; text?: string; error?: string; plannerTrace?: { planner?: string; model?: string; toolsExposed?: string[]; plan?: Array<{ toolId: string }>; promptBudget?: { tokens: number; estimated: number; trimmed: string[] }; route?: { policy: string; meter?: string; planner?: Decision; composer?: Decision; structured?: Decision[] } } };
const t0 = Date.now();
const r = await j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: H, body: JSON.stringify({ session: si.homeSession, addressee: String(si.agent).toLowerCase(), message: ASK }) })) as { reply?: Reply; error?: string };
const rep = r.reply;
if (!rep) fail(`no reply: ${JSON.stringify(r).slice(0, 300)}`);
const tr = rep!.plannerTrace;
console.log(`${HANDLE} asked: "${ASK}"\n  ${((Date.now() - t0) / 1000).toFixed(1)}s · ${rep!.kind}${rep!.error ? ` · ${rep!.error}` : ''} · planner ${tr?.planner ?? '-'}${tr?.model ? ` (${tr.model})` : ''} · plan [${(tr?.plan ?? []).map((s) => s.toolId).join(', ')}]${tr?.promptBudget ? ` · prompt ${tr.promptBudget.estimated}/${tr.promptBudget.tokens}${tr.promptBudget.trimmed.length ? ` trimmed ${tr.promptBudget.trimmed.join(',')}` : ''}` : ''}`);
console.log(`  said: ${String(rep!.text ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
const route = tr?.route;
if (!route) fail('the trace carries no route — is ORCHESTRATION_ROUTE set on this deployment?');
console.log(`\n── the route (policy ${route!.policy}; the minute counted by the ${route!.meter ?? 'isolate (no meter field — pre-W3 deployment)'} meter) ──`);
const line = (label: string, d?: Decision) => { if (!d) return; console.log(`  ${label.padEnd(12)} → ${d.provider ?? 'none'}\n  ${' '.repeat(12)}   ${d.because}`); };
line('planner', route!.planner);
for (const [i, d] of (route!.structured ?? []).entries()) line(`structured#${i + 1}`, d);
line('composer', route!.composer);
if (route!.policy !== 'budget') fail(`policy is ${route!.policy}, not budget`);
if (!route!.planner) fail('no planner decision on the trace');
if (!(route!.structured ?? []).length) console.log('  (no structured call ran — the planner did not choose a question tool; vary ASK)');
if (rep!.kind !== 'answer') fail(`the ask did not answer: ${rep!.kind} ${rep!.error ?? ''}`);
console.log(`\n✓ spec 388: every model call on this ask names its provider and the numbers it was routed by.`);

// Spec 390 W3 — THE SAME RUN AS A SPAN TREE: the authority stages, the planner's call and the outcome projected
// from the record's stamped events. Read under alice's session (her own run), names and durations only.
const runRef = (r as { runRef?: string }).runRef;
if (runRef) {
  await new Promise((res) => setTimeout(res, 1500)); // the record lands off the run's path
  const sp = await j(await fetch(`${HOME}/a2a/harness/spans`, { method: 'POST', headers: H, body: JSON.stringify({ session: si.homeSession, addressee: String(si.agent).toLowerCase(), runRef }) })) as { ok?: boolean; spans?: Array<{ name: string; spanId: string; parentSpanId?: string; startMs: number; endMs: number; status: string; attributes: Record<string, unknown> }>; error?: string };
  if (!sp.ok || !sp.spans) fail(`spans: ${sp.error ?? 'none'}`);
  const spans = sp.spans!;
  const t0 = Math.min(...spans.map((x) => x.startMs));
  const kids = (id?: string) => spans.filter((x) => x.parentSpanId === id).sort((a, b) => a.startMs - b.startMs);
  const walk = (id: string | undefined, depth: number) => { for (const x of kids(id)) { const a = x.attributes; console.log(`  ${'  '.repeat(depth)}${x.name.padEnd(46 - depth * 2)} +${String(x.startMs - t0).padStart(6)}ms ${String(x.endMs - x.startMs).padStart(6)}ms${a['gen_ai.provider.name'] ? ` · ${a['gen_ai.provider.name']}` : ''}${a['ap.authority.verdict'] ? ` · ${a['ap.authority.verdict']}` : ''}${a['ap.route.because'] ? ` · ${String(a['ap.route.because']).slice(0, 60)}…` : ''}`); walk(x.spanId, depth + 1); } };
  console.log(`\n── the run as spans (${spans.length}) ──`);
  walk(undefined, 0);
  const names = new Set(spans.map((x) => x.name.split(' ')[0]));
  for (const need of ['invoke_agent', 'plan', 'issue_outcome']) if (!names.has(need)) fail(`no ${need} span — the record's events are not stamped, or the stage projection did not run`);
  console.log(`\n✓ spec 390 W3: the run reads as a tree — the planner's call, each step, its verification, the outcome — with nothing the run was about.`);
  // Spec 389 W3 — the same run as its PROV graph, and the reply saying where the durable copy is.
  const hp = (r as { hasProvenance?: { agent: string; recordType: string } }).hasProvenance;
  if (!hp || hp.recordType !== `run.provenance:${runRef}`) fail(`the reply does not say where its provenance is: ${JSON.stringify(hp)}`);
  const pv = await j(await fetch(`${HOME}/a2a/harness/provenance`, { method: 'POST', headers: H, body: JSON.stringify({ session: si.homeSession, addressee: String(si.agent).toLowerCase(), runRef }) })) as { ok?: boolean; provenance?: { id: string; graph: unknown[]; hasTraceElement: string[] }; export?: { written?: boolean; error?: string } | null; error?: string };
  if (!pv.ok || !pv.provenance) fail(`provenance: ${pv.error ?? 'none'}`);
  console.log(`\n── the run as a graph ──\n  ${pv.provenance!.id} · ${pv.provenance!.graph.length} nodes, ${pv.provenance!.hasTraceElement.length} members · vault copy ${pv.export ? (pv.export.written ? 'written' : `NOT written: ${pv.export.error}`) : 'not yet reported'} · hasProvenance ${hp.agent} ${hp.recordType}`);
  if (pv.provenance!.id !== `urn:ap:prov:bundle:${runRef}`) fail(`bundle id ${pv.provenance!.id}`);
  console.log(`\n✓ spec 389 W3: the reply names its provenance and the graph is served to its asker.`);
  // Spec 391 — what the RECORD kept of each result: a body under the threshold, or a reference to an artifact in the
  // agent's vault (and, when the vault refused the write, the body whole with the refusal on the record).
  const rc = await j(await fetch(`${HOME}/a2a/harness/records`, { method: 'POST', headers: H, body: JSON.stringify({ session: si.homeSession, addressee: String(si.agent).toLowerCase(), runRef }) })) as { ok?: boolean; record?: { steps: Array<{ stepRef: string; toolId: string; result?: unknown }>; offloaded?: Array<{ stepRef: string; bytes: number; recordType: string; ok: boolean; error?: string }> } };
  if (rc.ok && rc.record) {
    const offloaded = rc.record.offloaded ?? [];
    console.log(`\n── the record's results ──`);
    for (const st of rc.record.steps) {
      const r = st.result as { $artifact?: string; recordType?: string; bytes?: number; summary?: string } | undefined;
      const size = JSON.stringify(st.result ?? null).length;
      console.log(`  ${st.stepRef} ${st.toolId}: ${r?.$artifact ? `→ artifact ${r.recordType} (${r.bytes} bytes; ${r.summary})` : `${size} chars kept whole`}`);
    }
    for (const o of offloaded) console.log(`  offload ${o.stepRef}: ${o.ok ? `written ${o.recordType} (${o.bytes} bytes)` : `REFUSED ${o.error} (${o.bytes} bytes kept whole)`}`);
    if (!offloaded.length) console.log(`  (no result crossed the offload threshold on this ask)`);
    if (offloaded.some((o) => !o.ok)) fail('an artifact write was refused — re-issue the agent\'s interactions grant for vault:run.artifact:* (scripts/reissue-interactions-grants.mts)');
  }
}
