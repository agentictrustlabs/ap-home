/**
 * Spec 387 W2 — SEE THE WHOLE FLOW, hop by hop, with each hop's output:
 *
 *   Claude.ai ──MCP──▶ AP Gateway (discover_agents · inspect_agent · invoke_agent)
 *                        ├─▶ registry POST /search            (gateway.discover)
 *                        ├─▶ the agent's card                  (gateway.card)
 *                        └─▶ A2A SendMessage as gateway.svc    (gateway.invoke)
 *                              └─▶ the agent's run: playbook → planner → catalog.* ──MCP──▶ content catalog
 *                                    └─▶ composer → the task: words + `results` + `trace` artifacts
 *
 *   TRACE=1 npx tsx scripts/trace-ap-gateway.mts                 (one live run; GATEWAY=… ASK=… FLOW=… to vary)
 *
 * Every hop is read from what the tools RETURN (`trace.hops`, the agent's `trace` artifact lifted in), never
 * from logs; the same flow id is on every Worker's log line (`[flow <id>]`) for `wrangler tail`.
 */
const GATEWAY = (process.env.GATEWAY ?? 'https://gc-discovery-connector.r-pedersen.workers.dev').replace(/\/$/, '');
const ASK = process.env.ASK ?? 'Build me a six-week study on justification from your catalog — one session a week, each naming its items with links.';
const FLOW = process.env.FLOW ?? `fl-${Math.random().toString(16).slice(2, 10)}`;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const call = async (name: string, args: Record<string, unknown>) => {
  const t0 = Date.now();
  const r = await j(await fetch(`${GATEWAY}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
  return { ms: Date.now() - t0, out: (r.result?.structuredContent ?? r.error ?? r) as Record<string, unknown> };
};
type Hop = { hop: string; ms: number; request?: Record<string, unknown>; response?: Record<string, unknown> } & Record<string, unknown>;
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const short = (v: unknown, n = 160) => JSON.stringify(v).slice(0, n);
const hopLine = (h: Hop) => console.log(`  ├─ ${h.hop.padEnd(16)} ${String(h.ms).padStart(6)} ms  ${h.request ? `in ${short(h.request, 140)}` : ''}\n  │  ${' '.repeat(23)}${h.response ? `out ${short(h.response, 200)}` : ''}`);

console.log(`flow ${FLOW} · gateway ${GATEWAY}\n`);
console.log('▶ Claude.ai ──MCP tools/call discover_agents──▶ gateway');
const d = await call('discover_agents', { topic: 'justification', capability: 'study plans', limit: 5, flow: FLOW });
const found = d.out as { agents?: Array<{ name: string; target: string | null; card: string }>; trace?: { hops: Hop[] }; explanation?: string; refused?: string };
for (const h of found.trace?.hops ?? []) hopLine(h);
console.log(`  └─ tool result ${d.ms} ms · ${found.explanation ?? found.refused ?? ''}`);
const hit = (found.agents ?? []).find((a) => a.target);
if (!hit) fail('no discovered agent carries a target handle');

console.log('\n▶ Claude.ai ──MCP tools/call inspect_agent──▶ gateway');
const i = await call('inspect_agent', { target: hit!.target, flow: FLOW });
const insp = i.out as { card?: { name?: string; skills?: Array<{ id: string }> }; trace?: { hops: Hop[] }; refused?: string };
for (const h of insp.trace?.hops ?? []) hopLine(h);
console.log(`  └─ tool result ${i.ms} ms · ${insp.refused ?? `${insp.card?.name} · skills ${(insp.card?.skills ?? []).map((s) => s.id).join(', ')}`}`);

console.log('\n▶ Claude.ai ──MCP tools/call invoke_agent──▶ gateway ──A2A SendMessage──▶ agent ──MCP──▶ its catalog');
const v = await call('invoke_agent', { target: hit!.target, message: ASK, flow: FLOW });
const out = v.out as { refused?: string; agent?: { name: string }; task?: { taskId: string | null; state: string; text: string; artifacts: Array<{ name?: string; data?: unknown }> }; trace?: { flowId: string; hops: Hop[] } };
if (out.refused) fail(out.refused);
for (const h of out.trace?.hops ?? []) {
  if (h.hop !== 'agent.run') { hopLine(h); continue; }
  const a = h as Hop & { agent: string; runRef: string; playbook: { archetypeId: string; digest: string } | null; planner: { kind: string; model?: string; toolsExposed: string[]; plan: Array<{ toolId: string; args: Record<string, unknown> }> } | null; steps: Array<{ toolId: string; ok: boolean; args?: unknown; output?: Record<string, unknown> }>; reply: { kind: string; chars: number; artifacts: string[] }; events: Array<{ type: string }> };
  // Spec 390 W2 — ONE W3C TRACE across Claude → gateway → agent: the gateway minted `traceparent` from the flow id
  // and the agent's run recorded it. Correlation only; the run admitted on the signed caller assertion.
  const gwTrace = (out.trace as { traceId?: string } | undefined)?.traceId;
  const runTrace = (a as { traceId?: string | null }).traceId ?? null;
  console.log(`  ├─ agent.run        ${String(a.ms).padStart(6)} ms  run ${a.runRef} at ${a.agent} (flow echoed: ${a.flowId === FLOW}; trace ${runTrace ? `${runTrace.slice(0, 12)}… ${runTrace === gwTrace ? '= the gateway\'s' : `≠ the gateway\'s ${String(gwTrace).slice(0, 12)}…`}` : 'none recorded'})`);
  if (!gwTrace || runTrace !== gwTrace) fail(`the run did not join the gateway's trace (gateway ${gwTrace ?? 'none'}, run ${runTrace ?? 'none'})`);
  console.log(`  │    playbook  ${a.playbook ? `${a.playbook.archetypeId} ${String(a.playbook.digest).slice(0, 12)}…` : 'none (bare harness)'}`);
  console.log(`  │    planner   ${a.planner?.kind ?? '-'}${a.planner?.model ? ` (${a.planner.model})` : ''} · offered ${a.planner?.toolsExposed.length ?? 0} tools [${(a.planner?.toolsExposed ?? []).filter((t) => t.startsWith('catalog.')).join(', ')} …] · plan ${short(a.planner?.plan ?? [], 200)}`);
  const route = (a.planner as { route?: { policy?: string; planner?: { because: string }; composer?: { because: string } } } | null)?.route;
  if (route) console.log(`  │    route     policy ${route.policy ?? '-'}\n  │      planner  ${route.planner?.because ?? '-'}\n  │      composer ${route.composer?.because ?? '-'}`);
  for (const st of a.steps) {
    const src = st.output?.source as { tool?: string; catalog?: string; ms?: number } | undefined;
    console.log(`  │    step      ${st.toolId} ${st.ok ? 'ok' : 'FAILED'} args ${short(st.args ?? {}, 120)}`);
    if (src) console.log(`  │      └─ MCP tools/call ${src.tool} @ ${src.catalog} ${src.ms} ms → ${short({ count: st.output?.count, total: st.output?.total, types: st.output?.types }, 160)}`);
    else if (st.output) console.log(`  │      └─ ${short(st.output, 200)}`);
  }
  console.log(`  │    composer  reply ${a.reply.kind}, ${a.reply.chars} chars · artifacts [${a.reply.artifacts.join(', ')}] · events ${a.events.map((e) => e.type).join(' → ')}`);
}
console.log(`  └─ tool result ${v.ms} ms · task ${out.task?.taskId} ${out.task?.state} · artifacts [${(out.task?.artifacts ?? []).map((a) => a.name).join(', ')}]`);

const results = (out.task?.artifacts ?? []).find((a) => a.name === 'results')?.data as Array<{ toolId: string; result: { resources?: Array<{ title: string; url: string }> } }> | undefined;
const items = results?.find((r) => r.toolId === 'catalog.resource.search')?.result.resources ?? [];
const text = out.task?.text ?? '';
// Composers write "Week 1" with a plain space, a no-break space or a narrow one; a week is a week.
const weeks = [...new Set((text.replace(/[\u00a0\u202f\u2011]/g, ' ').match(/Week [1-6]/g) ?? []))].sort();
console.log(`\n── what Claude.ai receives ──\n  words: ${text.length} chars, weeks present: ${weeks.join(' ') || 'none'}\n  results artifact: ${items.length} linked item(s)\n  trace artifact: ${(out.task?.artifacts ?? []).some((a) => a.name === 'trace') ? 'yes' : 'no'}`);
if (process.env.FULL) console.log(`\n${text}`);
if (!items.length) fail('no catalog items in the results artifact');
if (weeks.length < 6) fail(`the study is not complete (${weeks.join(' ')}) — raise COMPOSER_MAX_TOKENS`);
console.log(`\n✓ flow ${FLOW}: every hop visible with its output — registry → card → A2A task → run → catalog MCP → composer → artifacts; all six weeks present; one W3C trace from the gateway to the run.`);
