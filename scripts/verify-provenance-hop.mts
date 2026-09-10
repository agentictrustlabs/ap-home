/**
 * Spec 389 W3 — A RUN ACROSS TWO AGENTS READS AS ONE GRAPH FROM EITHER SIDE, and every reply says where its
 * provenance is. One live ask that ROUTES (alice asks her organization's agent for its roster — spec 366): the
 * reply carries `hasProvenance`; alice's run's graph has a step `delegatedToAgent` the organization whose activity
 * `wasInformedBy` the receiver's run; the receiver's run's graph (read under alice's session — she asked it) is a
 * bundle `wasInformedBy` alice's bundle. PROV-N is served for the same run.
 *
 *   npx tsx scripts/verify-provenance-hop.mts        (HANDLE=… ORG=… ASK=… to vary)
 */
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const HANDLE = process.env.HANDLE ?? 'alice';
const ORG = process.env.ORG ?? 'globalchurch.org';
const ASK = process.env.ASK ?? `who are the members of ${ORG}`;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: HANDLE, client_id: 'demo-web' }) }));
if (!si.homeSession) fail(`no session for ${HANDLE}`);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
const post = (path: string, body: unknown) => fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }).then(j);
const me = String(si.agent).toLowerCase();

type Node = Record<string, unknown> & { id: string; type?: string[] };
type Doc = { id: string; type: string[]; wasAttributedTo?: string; wasInformedBy?: string[]; hasTraceElement: string[]; graph: Node[] };

const t0 = Date.now();
const r = await post('/harness/ask', { session: si.homeSession, addressee: me, message: ASK }) as { reply?: { kind: string; text?: string; error?: string; routed?: Array<{ stepRef: string; agent: string; runRef?: string; observedVia: string }> }; runRef?: string; hasProvenance?: { agent: string; recordType: string }; error?: string };
if (!r.reply || !r.runRef) fail(`no reply: ${JSON.stringify(r).slice(0, 300)}`);
console.log(`${HANDLE} asked: "${ASK}"\n  ${((Date.now() - t0) / 1000).toFixed(1)}s · ${r.reply!.kind}${r.reply!.error ? ` · ${r.reply!.error}` : ''} · run ${r.runRef}\n  said: ${String(r.reply!.text ?? '').replace(/\s+/g, ' ').slice(0, 200)}`);
if (!r.hasProvenance || r.hasProvenance.recordType !== `run.provenance:${r.runRef}` || r.hasProvenance.agent !== me) fail(`the reply does not say where its provenance is: ${JSON.stringify(r.hasProvenance)}`);
console.log(`  hasProvenance → ${r.hasProvenance.agent} ${r.hasProvenance.recordType}`);
const hop = (r.reply!.routed ?? []).find((x) => x.runRef);
if (!hop) fail(`the ask did not route (routed: ${JSON.stringify(r.reply!.routed ?? [])}) — is ${ORG} an organization ${HANDLE} stewards?`);
console.log(`  routed step ${hop!.stepRef} → ${hop!.agent} run ${hop!.runRef} (${hop!.observedVia})`);

await new Promise((res) => setTimeout(res, 1500));
const mine = await post('/harness/provenance', { session: si.homeSession, addressee: me, runRef: r.runRef }) as { ok?: boolean; provenance?: Doc; error?: string };
if (!mine.ok || !mine.provenance) fail(`my provenance: ${mine.error ?? 'none'}`);
const doc = mine.provenance!;
console.log(`\n── ${HANDLE}'s run as a graph ──\n  ${doc.id} · ${doc.type.join(' ')} · attributed to ${doc.wasAttributedTo} · ${doc.graph.length} nodes`);
if (doc.id !== `urn:ap:prov:bundle:${r.runRef}`) fail(`bundle id ${doc.id}`);
const step = doc.graph.find((n) => n.id === `urn:ap:prov:act:${r.runRef}:${hop!.stepRef}`);
if (!step) fail(`no activity for the routed step ${hop!.stepRef}`);
const orgIri = String(step!['delegatedToAgent'] ?? '');
const informed = (step!['wasInformedBy'] as string[] | undefined) ?? [];
console.log(`  step ${hop!.stepRef}: delegatedToAgent ${orgIri} · wasInformedBy ${informed.join(', ') || 'nothing'}`);
if (!orgIri.endsWith(hop!.agent.toLowerCase())) fail(`the step does not name the organization it was routed to`);
if (!informed.includes(`urn:ap:prov:act:${hop!.runRef}`)) fail(`the step's activity was not informed by the receiver's run`);

const theirs = await post('/harness/provenance', { session: si.homeSession, addressee: hop!.agent.toLowerCase(), runRef: hop!.runRef }) as { ok?: boolean; provenance?: Doc; error?: string };
if (!theirs.ok || !theirs.provenance) fail(`the organization's provenance: ${theirs.error ?? 'none'}`);
const td = theirs.provenance!;
console.log(`\n── the organization's run as a graph ──\n  ${td.id} · attributed to ${td.wasAttributedTo} · wasInformedBy ${(td.wasInformedBy ?? []).join(', ') || 'nothing'} · ${td.graph.length} nodes`);
if (!(td.wasInformedBy ?? []).includes(doc.id)) fail(`the organization's bundle was not informed by ${HANDLE}'s bundle`);
const run = td.graph.find((n) => n.id === `urn:ap:prov:act:${hop!.runRef}`);
if (!run || !((run['wasInformedBy'] as string[] | undefined) ?? []).includes(`urn:ap:prov:act:${r.runRef}`)) fail(`the organization's run activity was not informed by ${HANDLE}'s run activity`);

const provn = await post('/harness/provenance', { session: si.homeSession, addressee: me, runRef: r.runRef, format: 'prov-n' }) as { ok?: boolean; provN?: string };
if (!provn.ok || !provn.provN?.startsWith('document')) fail('PROV-N was not served');
console.log(`\n  PROV-N: ${provn.provN!.split('\n').length} lines, begins "${provn.provN!.split('\n')[0]}", bundle ${provn.provN!.includes(`bundle <${doc.id}>`) ? 'present' : 'MISSING'}`);
const text = JSON.stringify([doc, td]).toLowerCase();
for (const word of ASK.toLowerCase().split(/\s+/).filter((w) => w.length > 5)) if (text.includes(`"${word}`)) fail(`a graph carries the ask's words (${word})`);
console.log(`\n✓ spec 389 W3: two agents, two bundles, one graph from either side — and every reply says where its provenance is.`);
