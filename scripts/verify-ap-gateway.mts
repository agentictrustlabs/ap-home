/**
 * Spec 387 W1 — THE GATEWAY AS AN A2A CLIENT, live: discover an agent through the registry, then ask it over A2A
 * as the gateway's own agent (gateway.svc), through the MCP surface an assistant would use.
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
const out = await call('invoke_agent', { target: hit!.target, message: 'what do you offer on justification?' }) as { task?: { taskId: string | null; state: string; text: string; artifacts: unknown[]; needs?: string }; refused?: string; agent?: { name: string } };
console.log(`  ${((Date.now() - t1) / 1000).toFixed(1)}s · ${out.refused ? `refused: ${out.refused}` : `${out.agent?.name} task ${out.task?.taskId} ${out.task?.state}${out.task?.needs ? ` (needs ${out.task.needs})` : ''}\n  said: ${JSON.stringify(out.task?.text ?? '').slice(0, 400)}\n  artifacts: ${out.task?.artifacts.length ?? 0}`}`);
if (out.refused) fail(out.refused);
if (!out.task?.state) fail('no task came back');
console.log(`\n✓ spec 387 W1: discovered through the registry, then asked over A2A as the gateway's own agent — the target ran it as its own task (${out.task!.state}).`);
