// THE LAB'S RUNNER, FROM THE HOME — spec 415 A5. What the Run tab sends and reads: the deployment's comparison knobs
// (`GET /harness/comparison`), a submission (`POST /harness/experiments`), its progress (`GET /harness/experiments/:id`)
// and a cancel. The session travels the way every harness call's does — in the body of a POST, in the query of a GET —
// and the CSRF token as the header `postA2a` adds. Numbers and ids come back; never a reply's words.
import { postA2a } from './ask';

/** The variant request as the runtime accepts it (per-area providers included, 2026-10-01). */
export interface LabVariantV1 {
  provider?: string; selectionProvider?: string; answerProvider?: string; judgeProvider?: string;
  selection?: string; plannerKind?: 'model' | 'rule-based'; judgeProfile?: 'thorough' | 'fast' | 'logprob';
  toggles?: Record<string, string>;
}

export interface ComparisonKnobsV1 {
  ok: boolean; evalCapture: 'on' | 'off';
  providers: string[]; providerRoles: string[]; selections: string[]; plannerKinds: string[];
  toggles: Record<string, readonly string[]>; build?: string;
}

export interface ExperimentProgressV1 {
  planId: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; total: number; done: number; failed: number;
  byOutcome: Record<string, number>; startedAt?: string; finishedAt?: string; error?: string;
  recent: Array<{ intentId: string; variant: string; repeat: number; status: string; outcome?: string; selected: string[]; ms: number }>;
  scores?: Record<string, Record<string, { value: number | null; ci?: [number, number] | null; num?: number; den?: number }>>;
  verdicts?: Record<string, { status: string; reason: string }>;
  comparisons?: Array<{ a: string; b: string; confounds: string[]; confounded: boolean; delta_macro?: number; fixed?: number; broken?: number; p_value?: number; error?: string }>;
  refused?: string[];
}

export interface ExperimentSubmissionV1 {
  addressee: string; set: unknown; criterion: unknown; fixtures?: unknown;
  variants: Record<string, LabVariantV1>; split: 'held-out' | 'development' | 'all'; repeats: number; planId?: string;
}

/** What this deployment's comparison knob knows: public, no session. */
export async function readComparisonKnobs(): Promise<ComparisonKnobsV1 | null> {
  const r = await fetch('/a2a/harness/comparison', { credentials: 'include' }).catch(() => null);
  if (!r || !r.ok) return null;
  const b = (await r.json().catch(() => null)) as ComparisonKnobsV1 | null;
  return b && b.ok ? b : null;
}

export async function startExperiment(token: string, s: ExperimentSubmissionV1): Promise<{ ok: true; progress: ExperimentProgressV1 } | { ok: false; error: string; refused?: string }> {
  const out = await postA2a('/a2a/harness/experiments', { session: token, addressee: s.addressee.toLowerCase(), set: s.set, criterion: s.criterion, ...(s.fixtures ? { fixtures: s.fixtures } : {}), variants: s.variants, split: s.split, repeats: s.repeats, ...(s.planId ? { planId: s.planId } : {}) });
  if (out['ok'] === true && out['progress']) return { ok: true, progress: out['progress'] as ExperimentProgressV1 };
  return { ok: false, error: String(out['error'] ?? 'the experiment could not be started'), ...(typeof out['refused'] === 'string' ? { refused: out['refused'] } : {}) };
}

export async function readExperiment(token: string, addressee: string, planId: string): Promise<ExperimentProgressV1 | null> {
  const r = await fetch(`/a2a/harness/experiments/${encodeURIComponent(planId)}?session=${encodeURIComponent(token)}&addressee=${addressee.toLowerCase()}`, { credentials: 'include' }).catch(() => null);
  if (!r) return null;
  const b = (await r.json().catch(() => null)) as { ok?: boolean; progress?: ExperimentProgressV1 } | null;
  return r.ok && b?.ok && b.progress ? b.progress : null;
}

export async function cancelExperiment(token: string, addressee: string, planId: string): Promise<ExperimentProgressV1 | null> {
  const out = await postA2a(`/a2a/harness/experiments/${encodeURIComponent(planId)}/cancel`, { session: token, addressee: addressee.toLowerCase() });
  return out['ok'] === true && out['progress'] ? (out['progress'] as ExperimentProgressV1) : null;
}

/** A variant row as the form holds it → the request the runtime accepts: empty choices are left out, so a row with
 *  nothing chosen is the live arm `{}` (the deployment's own defaults). */
export function variantFromForm(row: { provider?: string; selectionProvider?: string; answerProvider?: string; judgeProvider?: string; judgeProfile?: string; judge?: string; selection?: string }): LabVariantV1 {
  const v: LabVariantV1 = {};
  for (const k of ['provider', 'selectionProvider', 'answerProvider', 'judgeProvider'] as const) if (row[k]) v[k] = row[k];
  if (row.selection) v.selection = row.selection;
  if (row.judgeProfile === 'thorough' || row.judgeProfile === 'fast' || row.judgeProfile === 'logprob') v.judgeProfile = row.judgeProfile;
  if (row.judge && row.judge !== 'off') v.toggles = { 'quality/judge': row.judge };
  return v;
}
