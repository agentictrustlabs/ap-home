/**
 * Spec 387 W1+W2 — THE GATEWAY AS AN A2A CLIENT, live: discover an agent through the registry, then ask it over A2A
 * as the gateway's own agent (gateway.svc), through the MCP surface an assistant would use. W2: the agent answers
 * from ITS OWN catalog (its name record atl:mcpEndpoint → the content MCP), and the items ride back as the task's
 * `results` artifact — each with its link — beside the agent's words.
 *
 *   GATEWAY=https://gc-discovery-connector.r-pedersen.workers.dev npx tsx scripts/verify-ap-gateway.mts
 */
const GATEWAY = (process.env.GATEWAY ?? 'https://gc-discovery-connector.r-pedersen.workers.dev').replace(/\/$/, '');
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const call = async (name: string, args: Record<string, unknown>) => { const r = await j(await fetch(`${GATEWAY}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })); return (r.result?.structuredContent ?? r) as Record<string, unknown>; };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };

console.log('── discover_agents ──');
const t0 = Date.now();
const found = await call('discover_agents', { topic: 'justification', capability: 'study plans', limit: 5 }) as { agents?: Array<{ name: string; target: string | null; targetNote?: string; card: string; skills?: unknown[] }>; refused?: string; explanation?: string };
console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s · ${found.explanation ?? found.refused ?? ''}`);
for (const a of found.agents ?? []) console.log(`  ${a.name} · card ${a.card} · target ${a.target ? a.target.slice(0, 28) + '…' : `none (${a.targetNote})`}`);
const hit = (found.agents ?? []).find((a) => a.target);
if (!hit) fail('no discovered agent carries a target handle');

console.log('\n── inspect_agent ──');
const insp = await call('inspect_agent', { target: hit!.target }) as { card?: { name?: string; skills?: Array<{ id: string }> }; cardMatchesPin?: boolean; endpointMatchesPin?: boolean; refused?: string };
console.log(`  ${insp.refused ?? `${insp.card?.name} · skills ${(insp.card?.skills ?? []).map((s) => s.id).slice(0, 4).join(', ')} · card pinned ${insp.cardMatchesPin} · endpoint pinned ${insp.endpointMatchesPin}`}`);

console.log('\n── invoke_agent (as gateway.svc, over A2A) ──');
const t1 = Date.now();
const ASK = process.env.ASK ?? 'Build me a six-week study on justification from your catalog — one session a week, each naming its items with links.';
const out = await call('invoke_agent', { target: hit!.target, message: ASK }) as { task?: { taskId: string | null; state: string; text: string; artifacts: unknown[]; needs?: string }; refused?: string; agent?: { name: string } };
console.log(`  ${((Date.now() - t1) / 1000).toFixed(1)}s · ${out.refused ? `refused: ${out.refused}` : `${out.agent?.name} task ${out.task?.taskId} ${out.task?.state}${out.task?.needs ? ` (needs ${out.task.needs})` : ''}\n  said: ${JSON.stringify(out.task?.text ?? '').slice(0, 400)}\n  artifacts: ${out.task?.artifacts.length ?? 0}`}`);
if (out.refused) fail(out.refused);
if (!out.task?.state) fail('no task came back');
console.log(`  said: ${String(out.task?.text ?? '').replace(/\s+/g, ' ').slice(0, 900)}`);
// W2 — the catalog items are an ARTIFACT of the task, not a sentence to re-parse.
type Step = { toolId: string; result?: { count?: number; total?: number; resources?: Array<{ title: string; url: string }>; source?: { agent?: string; catalog?: string }; error?: string; refused?: string } };
const results = ((out.task?.artifacts ?? []) as Array<{ name?: string; data?: unknown }>).find((a) => a.name === 'results')?.data as Step[] | undefined;
const search = (results ?? []).find((r) => r.toolId === 'catalog.resource.search');
console.log(`  artifacts: ${(out.task?.artifacts ?? []).map((a) => (a as { name?: string }).name ?? '?').join(', ') || 'none'}${search ? ` · catalog.resource.search → ${search.result?.count ?? 0} of ${search.result?.total ?? '?'} item(s) from ${search.result?.source?.catalog ?? '?'}` : ''}`);
for (const r of (search?.result?.resources ?? []).slice(0, 6)) console.log(`    · ${r.title} — ${r.url}`);
if (!search) fail(`the task carried no catalog.resource.search result (steps: ${(results ?? []).map((r) => r.toolId).join(', ') || 'none'})`);
if (search.result?.error || search.result?.refused) fail(`the catalog read failed: ${search.result.error ?? search.result.refused}`);
if (!(search.result?.resources?.length)) fail('the catalog read returned no items');
if (!search.result.resources.every((r) => /^https:\/\//.test(r.url))) fail('an item came back without a link');
console.log(`\n✓ spec 387 W2: discovered through the registry, asked over A2A as the gateway's own agent, answered from the agent's OWN catalog (${search.result.source?.agent} → ${search.result.source?.catalog}) — ${search.result.resources.length} linked item(s) as the task's results artifact (${out.task!.state}).`);
