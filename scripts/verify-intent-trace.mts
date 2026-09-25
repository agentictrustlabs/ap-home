/**
 * Spec 414 A1f — THE TRACE FROM THE DOOR, LIVE. A person's intent arrives at her agent's A2A endpoint as one
 * `SendMessage`; the run's provenance names that door (the message, context and task ids), the variant it ran under,
 * the model calls it made and the harness capabilities that engaged — as a W3C PROV graph, with none of the words.
 *
 *   1. the live card declares `run-provenance/v1` (PROV-AQ on the wire);
 *   2. `SendMessage` (A2A 1.0, the person's Home session as the bearer) → a task whose metadata says where the run's
 *      provenance is (`hasProvenance`);
 *   3. `/harness/provenance` → the run `arrivedBy` a Door with doorKind `a2a-message` and THIS message's id and THIS
 *      task's id; `underVariant` a Variant named by sha256; `hasEngagement` names a planner; every model call carries
 *      a role; the graph carries none of the ask's words;
 *   4. the direct ask (`/harness/ask`) answers with a PROV-AQ `Link` header (`has_provenance`, `has_query_service`).
 *
 *   npx tsx scripts/verify-intent-trace.mts          (HANDLE=… TARGET=<agent name> ASK=… A2A_ENDPOINT=… to vary)
 */
import { fixture as fx, HOME } from './fixture.mts';

const HANDLE = process.env.HANDLE ?? fx.people.steward;
const TARGET = process.env.TARGET ?? `${HANDLE}.me`;
const ENDPOINT = process.env.A2A_ENDPOINT ?? `https://edge.faithnet.io/api/a2a/${TARGET}`;
const ASK = process.env.ASK ?? 'which organizations am I part of?';
const RUN_PROVENANCE_EXT = 'https://agenticprimitives.dev/a2a/extensions/run-provenance/v1';
const APEXEC = 'https://agenticprimitives.dev/ns/execution#';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };

const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: HANDLE, client_id: 'demo-web' }) }));
if (!si.homeSession) fail(`no session for ${HANDLE}`);
const me = String(si.agent).toLowerCase();

// ── 1. the card ──
const card = await j(await fetch(`${new URL(ENDPOINT).origin}/.well-known/agent-card.json`, { headers: { 'x-agent-name': TARGET } }).catch(() => new Response('{}')));
const exts = ((card?.capabilities?.extensions ?? []) as Array<{ uri: string }>).map((e) => e.uri);
console.log(`card: ${exts.length} extension(s)${exts.includes(RUN_PROVENANCE_EXT) ? ' — run-provenance/v1 declared' : ''}`);
if (!exts.includes(RUN_PROVENANCE_EXT)) console.warn('  (the card read here did not list run-provenance/v1 — the edge may serve a released card; the run below is the gate)');

// ── 2. the intent, at the A2A door ──
const messageId = `m-${crypto.randomUUID()}`;
const t0 = Date.now();
const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'a2a-version': '1.0', authorization: `Bearer ${si.homeSession}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId, role: 'ROLE_USER', parts: [{ text: ASK }] } } }),
});
const rpc = await j(res) as { result?: { task?: { id: string; contextId: string; status: { state: string }; metadata?: Record<string, unknown> } }; error?: { message?: string } };
const task = rpc.result?.task;
if (!task) fail(`no task: ${JSON.stringify(rpc).slice(0, 300)}`);
const hp = task!.metadata?.hasProvenance as { agent?: string; recordType?: string } | undefined;
const runRef = (task!.metadata?.runRef as string | undefined) ?? hp?.recordType?.replace(/^run\.provenance:/, '');
console.log(`${HANDLE} → ${TARGET}: "${ASK}"\n  ${((Date.now() - t0) / 1000).toFixed(1)}s · task ${task!.id} · ${task!.status.state} · run ${runRef ?? '?'}`);
if (!runRef) fail('the task does not name its run');
if (!hp?.recordType) fail(`the task does not say where its provenance is: ${JSON.stringify(task!.metadata ?? {}).slice(0, 200)}`);

// ── 3. the graph ──
await new Promise((r) => setTimeout(r, 2000));
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
const post = (path: string, body: unknown) => fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
const prov = await j(await post('/harness/provenance', { session: si.homeSession, addressee: (hp!.agent ?? me).toLowerCase(), runRef })) as { ok?: boolean; provenance?: { graph: Array<Record<string, unknown>> }; error?: string };
if (!prov.ok || !prov.provenance) fail(`provenance: ${prov.error ?? 'none'}`);
const graph = prov.provenance!.graph;
const node = (id: string) => graph.find((n) => n['id'] === id);
const run = node(`urn:ap:prov:act:${runRef}`) ?? fail('no run activity in the graph');
const door = node(String(run['arrivedBy'] ?? '')) ?? fail('R9: the run names no door');
console.log(`\n── the door ──\n  ${JSON.stringify(door)}`);
if (door['doorKind'] !== 'a2a-message') fail(`the door is ${String(door['doorKind'])}, not the A2A message it arrived as`);
if (door['a2aMessageId'] !== messageId) fail(`the door names message ${String(door['a2aMessageId'])}, not the one sent (${messageId})`);
if (door['a2aTaskId'] !== task!.id) fail(`the door names task ${String(door['a2aTaskId'])}, not ${task!.id}`);
const variant = node(String(run['underVariant'] ?? '')) ?? fail('R10: the run names no variant');
if (!/^sha256:[0-9a-f]{64}$/.test(String(variant['variantDigest']))) fail('R10: the variant is not named by sha256');
console.log(`── the variant ── ${String(variant['variantDigest']).slice(0, 18)}… planner ${String(variant['plannerKind'] ?? '-')} · route ${String(variant['routePolicy'] ?? '-')} · build ${String(variant['harnessBuild'] ?? '-')}`);
const engagements = (run['hasEngagement'] as Array<{ ofCapability: string; engagementEffect: string }> | undefined) ?? [];
console.log(`── engagements ── ${engagements.map((e) => `${e.ofCapability.replace(`${APEXEC}hc-`, '')}:${e.engagementEffect.replace(`${APEXEC}ee-`, '')}`).join(' · ') || 'none'}`);
if (!engagements.some((e) => e.ofCapability.startsWith(`${APEXEC}hc-planner`))) fail('no planner engagement — every run is planned by something');
const calls = ((run['hasModelInvocation'] as string[] | undefined) ?? []).map((id) => node(id));
console.log(`── model calls ── ${calls.map((c) => `${String(c?.['invocationRole'])}:${String(c?.['modelProvider'] ?? '-')}${c?.['modelId'] ? `/${String(c['modelId'])}` : ''}`).join(' · ') || 'none (a supplied or compiled plan, no composer call)'}`);
if (calls.some((c) => !c?.['invocationRole'])) fail('R8: a model call names no role');
const text = JSON.stringify(prov.provenance).toLowerCase();
for (const w of ASK.toLowerCase().split(/\W+/).filter((x) => x.length > 6)) if (text.includes(w)) fail(`the graph carries the ask's words ("${w}")`);

// ── 4. the Link header on a direct ask ──
const direct = await post('/harness/ask', { session: si.homeSession, addressee: me, message: ASK });
const link = direct.headers.get('link') ?? '';
console.log(`\n── the direct ask's Link ──\n  ${link || '(none)'}`);
if (!link.includes('prov#has_provenance') || !link.includes('prov#has_query_service')) fail('the direct ask answered without a PROV-AQ Link header');

console.log(`\n✓ spec 414 A1: the intent arrived at the A2A door and the run's PROV graph names that door, its variant, its model calls and the harness capabilities that engaged — without a word of the ask.`);
