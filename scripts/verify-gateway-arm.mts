/**
 * verify-gateway-arm — spec 434 §12, THE W3 GATE. Who may carry this estate's model calls?
 *
 * Two arms over the SAME asks, in one window, against the steward's own agent:
 *
 *   direct   `variant: { gateway: 'off' }`  — this Worker's own provider keys, the way every run goes today
 *   gateway  `variant: { gateway: 'on' }`   — the town's model gateway by PROFILE, under this estate's app key
 *
 * Nothing else differs: same sentences, same agent, same playbook, same tools. The arm sets one env key for the
 * run (`withGatewayVariant`), so planner, selection judge and composer are all carried the same way and cannot
 * disagree about which they used.
 *
 * WHAT MAKES IT A GATE, not a demo: the gateway's own counters are read before and after, so the claim "these
 * calls went through it" is the gateway's arithmetic and not this script's hope — and the direct arm must move
 * them by ZERO. A run that answers under one arm and not the other is the finding; so is a materially slower one.
 *
 *   npx tsx scripts/verify-gateway-arm.mts [--asks 4]
 *
 * Costs real tokens: ONE run per wave (the standing rule), Gemini-first profiles on both sides.
 */
import { fixture as fx, HOME } from './fixture.mts';

const OPS = (process.env.TOWN_OPS_TOKEN ?? '').trim();
const GATEWAY = (process.env.INFERENCE_URL ?? 'https://inference.faithnet.io').replace(/\/$/, '');
const N = Number((process.argv.find((a) => a.startsWith('--asks='))?.split('=')[1] ?? '4'));
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t) as Record<string, unknown>; } catch { return { _raw: t.slice(0, 300), _status: r.status } as Record<string, unknown>; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };

/** Asks no compiled shape claims — a compiled plan is decided BEFORE any planner (spec 355), and a gate about
 *  who carries the model call must reach a model at all. */
const ASKS = [
  'what can you help me with today?',
  'what should I know about my agent right now?',
  'summarise what you are able to do for me in two sentences',
  'what would you need from me before you could act on my behalf?',
].slice(0, Math.max(1, Math.min(N, 4)));

const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: fx.people.steward, client_id: 'demo-web' }) }));
if (!si.homeSession) fail(`no session for ${fx.people.steward}`);
const session = String(si.homeSession); const addressee = String(si.agent).toLowerCase();

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = await j(csrfRes);
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': String(csrf.token ?? '') };
const ask = async (message: string, gateway: 'on' | 'off') => {
  const t0 = Date.now();
  const r = await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: H, body: JSON.stringify({ session, addressee, message, variant: { gateway } }) });
  const body = await j(r);
  const reply = (body.reply ?? body) as Record<string, unknown>;
  const trace = (body.plannerTrace ?? reply.plannerTrace ?? {}) as { tokensIn?: number; tokensOut?: number; modelCalls?: unknown[] };
  return { status: r.status, ms: Date.now() - t0, kind: String(reply.kind ?? '—'), answered: r.status === 200 && reply.kind !== 'refused', tokens: (trace.tokensIn ?? 0) + (trace.tokensOut ?? 0), error: String(body.error ?? '').slice(0, 140) };
};

/** The gateway's own count of what it carried — the arithmetic this gate trusts instead of its own. */
const counters = async (): Promise<{ requests: number; costMicroUsd: number } | null> => {
  if (!OPS) return null;
  const r = await j(await fetch(`${GATEWAY}/v1/ops/summary?window=24h`, { headers: { authorization: `Bearer ${OPS}` } }));
  const t = (r.totals ?? {}) as { requests?: number; costMicroUsd?: number };
  return { requests: Number(t.requests ?? 0), costMicroUsd: Number(t.costMicroUsd ?? 0) };
};

const cmp = await j(await fetch(`${HOME}/a2a/harness/comparison`));
if (cmp.evalCapture !== 'on') fail('this estate does not run comparisons (EVAL_CAPTURE is not on) — the arm cannot be exercised here');
console.log(`── W3 gate ── ${ASKS.length} ask(s) × 2 arms, steward ${fx.people.steward} → own agent ${addressee}`);
if (!OPS) console.log('   (TOWN_OPS_TOKEN unset — the gateway\'s own counters will not be read, so the "it went through" half is unproven)');

const out: Record<'direct' | 'gateway', Array<Awaited<ReturnType<typeof ask>>>> = { direct: [], gateway: [] };
const moved = { direct: 0, gateway: 0 }; let costMicroUsd = 0;
const before = await counters();
let mark = before;
for (const message of ASKS) {
  // Direct first, then the gateway, on the same sentence — paired, so a slow minute hits both arms. The counters
  // are read BETWEEN the arms, which is what makes the negative control real: a direct run must move them by zero.
  out.direct.push(await ask(message, 'off'));
  const afterDirect = await counters();
  if (mark && afterDirect) moved.direct += afterDirect.requests - mark.requests;
  mark = afterDirect;
  out.gateway.push(await ask(message, 'on'));
  const afterGateway = await counters();
  if (mark && afterGateway) { moved.gateway += afterGateway.requests - mark.requests; costMicroUsd += afterGateway.costMicroUsd - mark.costMicroUsd; }
  mark = afterGateway;
  const d = out.direct[out.direct.length - 1]!, g = out.gateway[out.gateway.length - 1]!;
  console.log(`   “${message.slice(0, 44)}…”  direct ${d.status} ${d.kind} ${(d.ms / 1000).toFixed(1)}s${d.error ? ` (${d.error})` : ''}  ·  gateway ${g.status} ${g.kind} ${(g.ms / 1000).toFixed(1)}s${g.error ? ` (${g.error})` : ''}`);
}

const med = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2]! : Math.round(((s[s.length / 2 - 1] ?? 0) + (s[s.length / 2] ?? 0)) / 2); };
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
for (const arm of ['direct', 'gateway'] as const) {
  const rs = out[arm];
  console.log(`\n${arm.padEnd(8)} answered ${rs.filter((r) => r.answered).length}/${rs.length} · median ${(med(rs.map((r) => r.ms)) / 1000).toFixed(1)}s · tokens ${sum(rs.map((r) => r.tokens))}`);
}
if (before) {
  console.log(`\ngateway counters: the gateway arm moved them +${moved.gateway} request(s) (+$${(costMicroUsd / 1e6).toFixed(6)}); the direct arm moved them +${moved.direct}`);
  if (moved.gateway <= 0) fail('the gateway carried NOTHING — the `on` arm did not reach it (check INFERENCE_URL / INFERENCE_APP_KEY on the runtime)');
  // THE NEGATIVE CONTROL. If a direct run also lands at the gateway then the arm is not isolating anything and
  // neither column above means what it says.
  if (moved.direct !== 0) fail(`a DIRECT run reached the gateway ${moved.direct} time(s) — the arm is not isolating the carrier, so this comparison says nothing`);
}

// THE VERDICT. Both arms must answer; the gateway must not be materially slower. A failure here is a reason not to
// flip the deployment, and the numbers above are the reason — never this script's opinion of them.
const answeredD = out.direct.filter((r) => r.answered).length, answeredG = out.gateway.filter((r) => r.answered).length;
const medD = med(out.direct.map((r) => r.ms)), medG = med(out.gateway.map((r) => r.ms));
const regressed = answeredG < answeredD || (medD > 0 && medG > medD * 2);
console.log(`\n${regressed ? '✗' : '✓'} W3 arm: answered ${answeredG}/${out.gateway.length} vs ${answeredD}/${out.direct.length} direct · median ${(medG / 1000).toFixed(1)}s vs ${(medD / 1000).toFixed(1)}s`);
if (regressed) fail('the gateway arm regressed — do not flip ORCHESTRATION_GATEWAY on this deployment');
console.log('  → no regression on this pair. Flipping the deployment is ORCHESTRATION_GATEWAY = "on" in wrangler.toml.');
