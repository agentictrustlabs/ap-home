// THE LAB'S RUNNER, FROM THE HOME — spec 415 A5. What the Run tab sends and reads: the deployment's comparison knobs
// (`GET /harness/comparison`), a submission (`POST /harness/experiments`), its progress (`GET /harness/experiments/:id`)
// and a cancel. The session travels the way every harness call's does — in the body of a POST, in the query of a GET —
// and the CSRF token as the header `postA2a` adds. Numbers and ids come back; never a reply's words.
import { postA2a } from './ask';
import type { ArmRow } from './comparison-defaults';

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
export function variantFromForm(row: { provider?: string; selectionProvider?: string; answerProvider?: string; judgeProvider?: string; judgeProfile?: string; judge?: string; selection?: string; toggles?: Record<string, string> }): LabVariantV1 {
  const v: LabVariantV1 = {};
  for (const k of ['provider', 'selectionProvider', 'answerProvider', 'judgeProvider'] as const) if (row[k]) v[k] = row[k];
  if (row.selection) v.selection = row.selection;
  if (row.judgeProfile === 'thorough' || row.judgeProfile === 'fast' || row.judgeProfile === 'logprob') v.judgeProfile = row.judgeProfile;
  const toggles: Record<string, string> = {};
  for (const [k, x] of Object.entries(row.toggles ?? {})) if (k !== 'quality/judge' && x) toggles[k] = x;
  if (row.judge && row.judge !== 'off') toggles['quality/judge'] = row.judge;
  if (Object.keys(toggles).length) v.toggles = toggles;
  return v;
}

/** The form's own limits, shared by the form and a deep link's `arms`. */
export const ARM_NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/i;
export const PREFILL_MAX_ARMS = 8;
export const PREFILL_MAX_REPEATS = 5;
const JUDGE_PROFILE_VALUES = ['thorough', 'fast', 'logprob'];

/** base64url (padding optional) → UTF-8 text; null when it is not base64url. */
export function decodeBase64Url(raw: string): string | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(raw)) return null;
  const b64 = raw.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (b64.length % 4 === 1) return null;
  try {
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch { return null; }
}

/** One variant request → the form row that would produce it, or the reason the form could not hold it. Every value is
 *  checked against what THIS deployment offers (the same lists the form's selects are built from); a value the form
 *  could not show is a refusal, never typed in. */
export function rowFromVariant(name: string, v: unknown, knobs: Pick<ComparisonKnobsV1, 'providers' | 'selections' | 'toggles'>): { row: ArmRow } | { refused: string } {
  if (!ARM_NAME.test(name)) return { refused: `arm name "${name.slice(0, 44)}" is not a name the form accepts` };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { refused: `arm ${name} is not a variant request` };
  const row: ArmRow = { name, provider: '', selectionProvider: '', answerProvider: '', judgeProvider: '', judgeProfile: '', judge: 'off', selection: '' };
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'provider' || k === 'selectionProvider' || k === 'answerProvider' || k === 'judgeProvider') {
      if (typeof raw !== 'string' || !knobs.providers.includes(raw)) return { refused: `arm ${name}: ${k} "${String(raw)}" is not offered here` };
      row[k] = raw;
    } else if (k === 'selection') {
      if (typeof raw !== 'string' || !knobs.selections.includes(raw)) return { refused: `arm ${name}: selection "${String(raw)}" is not offered here` };
      row.selection = raw;
    } else if (k === 'judgeProfile') {
      if (typeof raw !== 'string' || !JUDGE_PROFILE_VALUES.includes(raw)) return { refused: `arm ${name}: judge profile "${String(raw)}" is not one the form offers` };
      row.judgeProfile = raw;
    } else if (k === 'toggles') {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { refused: `arm ${name}: toggles is not an object` };
      for (const [t, x] of Object.entries(raw as Record<string, unknown>)) {
        const allowed = knobs.toggles[t];
        if (!allowed || typeof x !== 'string' || !allowed.includes(x)) return { refused: `arm ${name}: toggle ${t}=${String(x)} is not offered here` };
        if (t === 'quality/judge') row.judge = x; else (row.toggles ??= {})[t] = x;
      }
    } else return { refused: `arm ${name}: "${k}" is not a choice the form holds` };
  }
  return { row };
}

/** A deep link's `arms` — base64url of the JSON `{ <arm name>: <variant request> }` — → the form's rows, all or none: an
 *  arm the form could not hold refuses the whole parameter (a half-applied set of arms would be a different experiment),
 *  and the notice says why in one line. */
export function armsFromParam(raw: string, knobs: Pick<ComparisonKnobsV1, 'providers' | 'selections' | 'toggles'>): { rows: ArmRow[] } | { notice: string } {
  const text = decodeBase64Url(raw.trim());
  if (text === null) return { notice: 'The link\'s arms were ignored: not base64url.' };
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { notice: 'The link\'s arms were ignored: not JSON.' }; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { notice: 'The link\'s arms were ignored: not an object of named arms.' };
  const entries = Object.entries(json as Record<string, unknown>);
  if (!entries.length) return { notice: 'The link\'s arms were ignored: no arms.' };
  if (entries.length > PREFILL_MAX_ARMS) return { notice: `The link's arms were ignored: ${entries.length} arms, the most a link may carry is ${PREFILL_MAX_ARMS}.` };
  const rows: ArmRow[] = [];
  for (const [name, v] of entries) {
    const r = rowFromVariant(name, v, knobs);
    if ('refused' in r) return { notice: `The link's arms were ignored: ${r.refused}.` };
    rows.push(r.row);
  }
  return { rows };
}

export interface PrefillV1 { addressee?: string; setId?: string; repeats?: number; rows?: ArmRow[]; notice?: string }

/** Spec 415 A5 — A DEEP LINK INTO THE RUN TAB. `?agent=<address|name>&set=<set id>` preselects the agent and the set
 *  once both lists have loaded; a value that names nothing in the lists is ignored (never typed into the form). The
 *  skills app's Runner links here with the agent it just tested and the archetype's set. A link can carry the whole run
 *  too: `&repeats=<1..5>` and `&arms=<base64url of JSON {name: VariantRequest}>` (read only once the deployment's knobs
 *  are known — pass them; without them both are left alone). The arms become the form's rows, still editable before
 *  Run. Pure: given the query and the lists, says what to select. */
export function prefillFromQuery(search: string, orgs: ReadonlyArray<{ agent: string; name: string }>, sets: ReadonlyArray<{ id: string }>, knobs?: Pick<ComparisonKnobsV1, 'providers' | 'selections' | 'toggles'> | null): PrefillV1 {
  const q = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  const out: PrefillV1 = {};
  const agent = (q.get('agent') ?? '').trim().toLowerCase();
  if (agent) { const hit = orgs.find((o) => o.agent.toLowerCase() === agent || (o.name ?? '').toLowerCase() === agent); if (hit) out.addressee = hit.agent; }
  const set = (q.get('set') ?? '').trim();
  if (set && sets.some((x) => x.id === set)) out.setId = set;
  const rep = (q.get('repeats') ?? '').trim();
  if (/^\d+$/.test(rep) && Number(rep) >= 1 && Number(rep) <= PREFILL_MAX_REPEATS) out.repeats = Number(rep);
  const arms = q.get('arms');
  if (arms && knobs) { const a = armsFromParam(arms, knobs); if ('rows' in a) out.rows = a.rows; else out.notice = a.notice; }
  return out;
}
