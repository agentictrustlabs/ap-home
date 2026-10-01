// THE LAB'S EXPERIMENT OBJECT — spec 415 A5. One Durable Object per plan id, running a comparison on the deployment
// itself: the same pre-registration, per-case judgement and scoring as `ap eval compare` (startComparison ·
// runOneCase · finishComparison from @agenticprimitives/evaluation), driven ONE CASE PER ALARM so a 77-case run of
// twenty minutes survives request limits, isolate restarts and a watcher closing the page. Progress is readable at any
// time; the record, when done, is the same `ap.experiment.v1` the CLI writes.
//
// HOW A CASE IS ASKED. The object dispatches to this deployment's own `/harness/ask` and `/harness/provenance` routes
// IN-ISOLATE (`markInWorker` + `app.fetch`): the request never crosses a socket, the CSRF gate steps aside for it (the
// same door the commitment delivery uses), and every gate the route applies — the session, the steward check on the
// variant, the window — applies unchanged. The object holds no model key and chooses no provider; the variant does,
// and the ask route refuses what the deployment does not offer.
//
// WHAT IT STORES. The job (set, gold, plan, the asker's session, the addressee), the runner's state, the runs so far,
// the cursor, and — when done — the record. Numbers and ids only: the eval store the runner writes through is this
// object's storage, and it keeps what `projectRunForExport` projects at the window's level, never a reply's words.
// Wiped, it is a job to resubmit; the harness's own run records are the record of what ran (ADR-0055).
import {
  startComparison, runOneCase, finishComparison, comparisonSteps, pseudonymiser, validateCaptureWindow,
  type ComparisonInput, type ComparisonState, type ComparisonPorts, type EvalStoreLike, type ExperimentRunV1, type ExperimentRecordV1, type EvalCaptureWindowV1,
} from '@agenticprimitives/evaluation';
import { isInternalCall, internalHeaders, markInWorker, type InternalMarkerEnv } from './internal-marker.js';
import { progressOf, type ExperimentJobV1, type ExperimentStatusV1 } from './experiment-job.js';

export type ExperimentEnv = InternalMarkerEnv & { EVAL_CAPTURE?: string };

type Op =
  | { op: 'start'; job: ExperimentJobV1; window?: EvalCaptureWindowV1 | null }
  | { op: 'status' }
  | { op: 'record' }
  | { op: 'cancel' };

const KEY = { job: 'job', state: 'state', runs: 'runs', cursor: 'cursor', status: 'status', record: 'record', error: 'error', salt: 'salt', window: 'window', finishedAt: 'finishedAt' } as const;
/** Between cases: long enough that an alarm never overlaps the previous one, short enough that the run is paced by
 *  the estate, not by the object. */
const STEP_DELAY_MS = 250;
/** A case the estate never answered (a hung ask) is a failed run after this long, so the object moves on. */
const CASE_TIMEOUT_MS = 180_000;

/** The deployment's own router, loaded when first needed: this module is imported BY index.ts (the class is exported
 *  from there), so a static import back would be a cycle at load time. */
async function routerFor(): Promise<{ fetch(req: Request, env: unknown, ctx: ExecutionContext): Promise<Response> }> {
  const m = await import('./index.js');
  return m.default as { fetch(req: Request, env: unknown, ctx: ExecutionContext): Promise<Response> };
}

export class ExperimentDO {
  constructor(private state: DurableObjectState, private env: ExperimentEnv) {}

  async fetch(request: Request): Promise<Response> {
    if (!isInternalCall(request, this.env)) return Response.json({ ok: false, error: 'internal only' }, { status: 403 });
    const body = (await request.json().catch(() => null)) as Op | null;
    if (!body?.op) return Response.json({ ok: false, error: 'op required' }, { status: 400 });
    if (body.op === 'start') return this.start(body.job, body.window ?? null);
    if (body.op === 'status') return Response.json({ ok: true, progress: await this.progress() });
    if (body.op === 'record') { const rec = await this.state.storage.get<ExperimentRecordV1>(KEY.record); return rec ? Response.json({ ok: true, record: rec }) : Response.json({ ok: false, error: 'not finished' }, { status: 409 }); }
    if (body.op === 'cancel') {
      const status = await this.state.storage.get<ExperimentStatusV1>(KEY.status);
      if (status === 'done' || status === 'failed') return Response.json({ ok: false, error: `already ${status}` }, { status: 409 });
      await this.state.storage.put(KEY.status, 'cancelled'); await this.state.storage.deleteAlarm();
      return Response.json({ ok: true, progress: await this.progress() });
    }
    return Response.json({ ok: false, error: `unknown op ${String((body as { op: string }).op)}` }, { status: 400 });
  }

  private async start(job: ExperimentJobV1, window: EvalCaptureWindowV1 | null): Promise<Response> {
    const existing = await this.state.storage.get<ExperimentStatusV1>(KEY.status);
    if (existing === 'queued' || existing === 'running') return Response.json({ ok: false, error: `plan ${job.planId} is already ${existing}`, refused: 'experiment.running' }, { status: 409 });
    if (window) { const v = validateCaptureWindow(window); if (!v.ok) return Response.json({ ok: false, error: `window: ${v.errors.join('; ')}` }, { status: 400 }); }
    // A fresh job replaces a finished one of the same id only if the plan is the same plan (the runner refuses a changed
    // plan under an old id — a changed plan is a new plan — which is what startComparison enforces below).
    const salt = (await this.state.storage.get<string>(KEY.salt)) ?? crypto.randomUUID();
    await this.state.storage.put({ [KEY.job]: job, [KEY.window]: window, [KEY.salt]: salt, [KEY.runs]: [], [KEY.cursor]: 0, [KEY.status]: 'queued' });
    await this.state.storage.delete([KEY.record, KEY.error, KEY.state, KEY.finishedAt]);
    try {
      const st = await startComparison(await this.input(job, window, salt));
      await this.state.storage.put({ [KEY.state]: st, [KEY.status]: 'running' });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await this.state.storage.put({ [KEY.status]: 'failed', [KEY.error]: error });
      return Response.json({ ok: false, error, refused: 'experiment.plan' }, { status: 400 });
    }
    await this.state.storage.setAlarm(Date.now() + STEP_DELAY_MS);
    return Response.json({ ok: true, progress: await this.progress() });
  }

  /** One case per alarm. The next alarm is armed BEFORE the case runs, so a crash mid-case re-runs that case rather
   *  than stalling the experiment; the cursor advances only after the run is stored. */
  async alarm(): Promise<void> {
    const status = await this.state.storage.get<ExperimentStatusV1>(KEY.status);
    if (status !== 'running') return;
    const job = await this.state.storage.get<ExperimentJobV1>(KEY.job);
    const st = await this.state.storage.get<ComparisonState>(KEY.state);
    const salt = await this.state.storage.get<string>(KEY.salt);
    const window = (await this.state.storage.get<EvalCaptureWindowV1 | null>(KEY.window)) ?? null;
    if (!job || !st || !salt) { await this.state.storage.put({ [KEY.status]: 'failed', [KEY.error]: 'the job was lost' }); return; }
    const steps = comparisonSteps(job.plan, st.intents);
    const cursor = (await this.state.storage.get<number>(KEY.cursor)) ?? 0;
    const runs = (await this.state.storage.get<ExperimentRunV1[]>(KEY.runs)) ?? [];
    const input = await this.input(job, window, salt, st);
    if (cursor >= steps.length) {
      try {
        const record = await finishComparison(input, st, runs);
        await this.state.storage.put({ [KEY.record]: record, [KEY.status]: 'done', [KEY.finishedAt]: record.finishedAt });
      } catch (e) { await this.state.storage.put({ [KEY.status]: 'failed', [KEY.error]: `scoring failed: ${e instanceof Error ? e.message : String(e)}` }); }
      return;
    }
    await this.state.storage.setAlarm(Date.now() + CASE_TIMEOUT_MS);
    const step = steps[cursor]!;
    let run: ExperimentRunV1;
    try { run = await runOneCase(input, st, step); }
    catch (e) { run = { intentId: step.intent.id, variant: step.variantName, repeat: step.repeat, runRef: null, status: 'failed', selected: [], evidence: 'none', captureLevel: null, ms: 0, error: `the case threw: ${e instanceof Error ? e.message : String(e)}` }; }
    runs.push(run);
    await this.state.storage.put({ [KEY.runs]: runs, [KEY.cursor]: cursor + 1, [KEY.state]: st });
    await this.state.storage.setAlarm(Date.now() + STEP_DELAY_MS);
  }

  private async progress() {
    const job = await this.state.storage.get<ExperimentJobV1>(KEY.job);
    const status = (await this.state.storage.get<ExperimentStatusV1>(KEY.status)) ?? 'queued';
    const st = await this.state.storage.get<ComparisonState>(KEY.state);
    const runs = (await this.state.storage.get<ExperimentRunV1[]>(KEY.runs)) ?? [];
    const total = job && st ? comparisonSteps(job.plan, st.intents).length : 0;
    const error = await this.state.storage.get<string>(KEY.error);
    const finishedAt = await this.state.storage.get<string>(KEY.finishedAt);
    const rec = status === 'done' ? await this.state.storage.get<ExperimentRecordV1>(KEY.record) : undefined;
    return { ...progressOf({ planId: job?.planId ?? this.state.id.toString() }, status, runs, total, { ...(st ? { startedAt: st.startedAt } : {}), ...(finishedAt ? { finishedAt } : {}), ...(error ? { error } : {}) }), ...(rec ? { scores: Object.fromEntries(Object.entries(rec.scores).map(([k, v]) => [k, v.aggregate])), verdicts: Object.fromEntries(Object.entries(rec.verdicts).map(([k, v]) => [k, { status: v.status, reason: v.binding_reason }])), comparisons: rec.comparisons.map((c) => ({ a: c.a, b: c.b, confounds: c.confounds, confounded: c.confounded, ...(c.comparison ? { delta_macro: c.comparison.delta_macro, fixed: c.comparison.fixed, broken: c.comparison.broken, p_value: c.comparison.p_value } : {}), ...(c.error ? { error: c.error } : {}) })), refused: rec.refused } : {}) };
  }

  /** The runner's input: the job's data, this object's storage as the eval store, and ports that dispatch in-isolate. */
  private async input(job: ExperimentJobV1, window: EvalCaptureWindowV1 | null, salt: string, state?: ComparisonState): Promise<ComparisonInput> {
    const storage = this.state.storage;
    const store: EvalStoreLike = {
      async put(ref, document) { await storage.put(`store:${ref.agent}/${ref.key}`, document); return { ok: true }; },
      async get(ref) { const d = await storage.get<Record<string, unknown>>(`store:${ref.agent}/${ref.key}`); return d ? { status: 'found', document: d } : { status: 'absent' }; },
    };
    const env = this.env;
    const post = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const app = await routerFor();
      const req = markInWorker(new Request(`${job.origin}${path}`, { method: 'POST', headers: internalHeaders(env, { 'content-type': 'application/json', accept: 'application/json' }), body: JSON.stringify(body) }));
      const res = await app.fetch(req, env, { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext);
      const text = await res.text();
      try { return JSON.parse(text) as Record<string, unknown>; } catch { return { ok: false, error: `${path} answered ${res.status}: ${text.slice(0, 160)}` }; }
    };
    const ports: ComparisonPorts = {
      // The same ask the CLI sends: the session, the addressee, the message, the variant and a run reference of its own.
      async ask({ intentId, message, variant, variantName, repeat }) {
        const runRef = `lab-${job.planId}-${variantName}-${intentId}-${repeat}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 180);
        const live = variant && typeof variant === 'object' && Object.keys(variant).length === 0;
        const r = await post('/harness/ask', { session: job.session, addressee: job.addressee, message, ...(live ? {} : { variant }), runRef }) as { ok?: boolean; error?: string; refused?: string; reply?: { kind?: string; error?: string; text?: string; plannerTrace?: { selection?: unknown } }; hasProvenance?: { recordType?: string } };
        if (r.ok === false || r.error) return { ok: false, error: `${r.refused ? `${r.refused}: ` : ''}${r.error ?? 'the ask failed'}` };
        const said = String(r.reply?.error ?? r.reply?.text ?? '');
        if (r.reply?.kind === 'refused' && /planner_failed:.*HTTP (402|429|5\d\d)/.test(said)) return { ok: false, error: `provider: ${said.slice(0, 160)}` };
        const rt = r.hasProvenance?.recordType;
        return { ok: true, runRef: typeof rt === 'string' && rt.startsWith('run.provenance:') ? rt.slice('run.provenance:'.length) : runRef, ...(r.reply?.plannerTrace?.selection ? { selection: r.reply.plannerTrace.selection } : {}), ...(r.reply?.plannerTrace ? { trace: r.reply.plannerTrace } : {}) };
      },
      async readProvenance(runRef) {
        for (let i = 0; i < 20; i++) {
          const r = await post('/harness/provenance', { session: job.session, addressee: job.addressee, runRef }) as { ok?: boolean; provenance?: Record<string, unknown> };
          if (r.ok && r.provenance) return r.provenance;
          await new Promise((res) => setTimeout(res, 3000));
        }
        return null;
      },
      async readMeasures(runRef) {
        for (let i = 0; i < 10; i++) {
          const r = await post('/harness/provenance', { session: job.session, addressee: job.addressee, runRef, format: 'measures' }) as { ok?: boolean; measures?: Record<string, unknown>; status?: string };
          if (r.ok && r.measures) return r.measures;
          if (r.status === 'refused') return null;
          await new Promise((res) => setTimeout(res, 3000));
        }
        return null;
      },
    };
    void state;
    return {
      set: job.set, criterion: job.criterion, plan: job.plan, ...(job.fixtures ? { fixtures: job.fixtures } : {}),
      window, estate: job.origin, estateCapture: String(env.EVAL_CAPTURE ?? '').trim().toLowerCase() === 'on' ? 'on' : 'off',
      asker: job.asker, addressee: job.addressee, store, pseudo: pseudonymiser(salt), ports,
      log: (line) => console.log(`[lab ${job.planId}] ${line}`),
    };
  }
}
