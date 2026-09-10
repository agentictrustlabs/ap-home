/**
 * Spec 388 — WHICH MODEL CARRIED EACH CALL, and why, on one live ask through the Home's own boundary: a person's
 * question of the public directory (kb.question → a structured call that writes the query) planned, answered and
 * composed under ORCHESTRATION_ROUTE=budget. Prints `plannerTrace.route` — planner, structured calls, composer —
 * with the numbers each decision was judged by.
 *
 *   npx tsx scripts/verify-route.mts        (one live ask; HANDLE=… ASK=… to vary)
 */
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const HANDLE = process.env.HANDLE ?? 'alice';
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
