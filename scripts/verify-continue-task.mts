/**
 * Spec 387 W3 — A TASK THAT NEEDS INPUT, CONTINUED FROM THE HOST, live: discover → invoke an ask whose step lacks a
 * required argument → the agent parks the run and the task says INPUT_REQUIRED with the prompt's fields →
 * continue_task answers on the SAME task → the run resumes from its checkpoint and completes. The referral (the
 * registry the gateway found the agent through) rides on the message and is echoed on the trace.
 *
 *   npx tsx scripts/verify-continue-task.mts       (one live run; GATEWAY=… ASK=… ANSWER_ID=… to vary)
 */
const GATEWAY = (process.env.GATEWAY ?? 'https://gc-discovery-connector.r-pedersen.workers.dev').replace(/\/$/, '');
const ASK = process.env.ASK ?? 'Fetch one specific item from your catalog by its id and give me its full record. I have the id ready — ask me for it.';
const ANSWER_ID = process.env.ANSWER_ID ?? 'pauls-transformation-in-christ';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const call = async (name: string, args: Record<string, unknown>) => { const r = await j(await fetch(`${GATEWAY}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })); return (r.result?.structuredContent ?? r.error ?? r) as Record<string, unknown>; };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
type Task = { taskId: string | null; state: string; text: string; needs?: string; prompt?: { kind?: string; prompt?: string; stepRef?: string; fields?: Array<{ name: string }> }; artifacts: Array<{ name?: string; data?: unknown }> };
type Trace = { flowId: string; hops: Array<{ hop: string; ms: number; referral?: { registry: string; receipt?: string }; continued?: boolean; steps?: Array<{ toolId: string; ok: boolean; output?: Record<string, unknown> }> }> };

console.log('── discover_agents ──');
const found = await call('discover_agents', { topic: 'justification', capability: 'study plans', limit: 5 }) as { agents?: Array<{ name: string; target: string | null }>; trace?: Trace; refused?: string };
const hit = (found.agents ?? []).find((a) => a.target);
if (!hit) fail(`no discovered agent carries a target handle (${found.refused ?? ''})`);
const flow = found.trace!.flowId;
console.log(`  ${hit!.name} · flow ${flow}`);

console.log('\n── invoke_agent: an ask whose step needs an argument the words do not carry ──');
const t0 = Date.now();
const first = await call('invoke_agent', { target: hit!.target, message: ASK, flow }) as { task?: Task; trace?: Trace; refused?: string };
if (first.refused) fail(first.refused);
const agentHop = (first.trace?.hops ?? []).find((h) => h.hop === 'agent.run');
console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s · task ${first.task?.taskId} ${first.task?.state}${first.task?.needs ? ` needs ${first.task.needs}` : ''}`);
console.log(`  said: ${String(first.task?.text ?? '').replace(/\s+/g, ' ').slice(0, 220)}`);
console.log(`  referral on the trace: ${agentHop?.referral ? `${agentHop.referral.registry}${agentHop.referral.receipt ? ` · receipt ${agentHop.referral.receipt}` : ''}` : 'none'}`);
if (!agentHop?.referral) fail('the agent did not echo the referral');
if (first.task?.state !== 'TASK_STATE_INPUT_REQUIRED') fail(`expected INPUT_REQUIRED, got ${first.task?.state} — the planner searched instead of asking; vary ASK`);
const fields = (first.task.prompt?.fields ?? []).map((f) => f.name);
console.log(`  prompt: "${first.task.prompt?.prompt ?? ''}" · fields [${fields.join(', ')}] · step ${first.task.prompt?.stepRef}`);
const field = fields.includes('id') ? 'id' : fields[0];
if (!field) fail('the prompt names no field to answer');

console.log('\n── continue_task: the answer on the SAME task ──');
const t1 = Date.now();
const second = await call('continue_task', { target: hit!.target, task: first.task.taskId, answer: { [field!]: ANSWER_ID }, flow }) as { task?: Task; trace?: Trace; refused?: string };
if (second.refused) fail(second.refused);
const hop2 = [...(second.trace?.hops ?? [])].reverse().find((h) => h.hop === 'agent.run');
console.log(`  ${((Date.now() - t1) / 1000).toFixed(1)}s · task ${second.task?.taskId} ${second.task?.state} · continued ${hop2?.continued === true} · steps ${(hop2?.steps ?? []).map((s) => `${s.toolId}${s.ok ? '' : '✗'}`).join(', ') || 'none'}`);
console.log(`  said: ${String(second.task?.text ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
if (second.task?.taskId !== first.task.taskId) fail('the continuation did not land on the same task');
if (second.task?.state !== 'TASK_STATE_COMPLETED') fail(`the continued task is ${second.task?.state}`);
if (!hop2?.continued) fail('the agent did not mark the run as continued');
const got = (hop2?.steps ?? []).find((s) => s.toolId === 'catalog.resource.get');
if (!got?.ok) fail('the continued run did not fetch the item');
console.log(`\n✓ spec 387 W3: the agent asked for the id, the host answered on the same task, the run resumed from its checkpoint and completed (${second.task.state}); the referral rode with the first message.`);
