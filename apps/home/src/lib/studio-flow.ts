// The Card & Projections LANDING, as pure logic (flow-redesign.md §2–§4, §7, §9). Three ordered stages —
// Describe → Make it live → List it — each with one status sentence and one primary action. `[Publish]` runs
// the whole release chain as a single busy action; this module decides which ops run, in which order, what
// the button says while they run, and where the chain must STOP because a different person has to act or a
// real decision is needed. No React, no I/O: every sentence a steward reads on the landing is assembled here
// so a test can prove the main path never uses our vocabulary (§9.4).
import type { A2AAgentCardReleaseV1, CardDraftState, CardReleaseState } from '@agenticprimitives/agent-profile/a2a';
import { diagnosticView, gateForOp, type StudioOp } from './studio-view';
import type { ProjectionDiagnosticV1 } from '@agenticprimitives/types';

// ── the publish chain ────────────────────────────────────────────────────────────────────────────────────

export type PublishStepId = 'create-release' | 'request-approval' | 'approve' | 'sign' | 'publish' | 'verify';

/** What the busy button says during each step — the user's words, not the state machine's. */
export const PUBLISH_PHRASE: Record<'check' | PublishStepId, string> = {
  check: 'Checking the description…',
  'create-release': 'Freezing this version…',
  'request-approval': 'Freezing this version…',
  approve: 'Freezing this version…',
  sign: 'Signing it…',
  publish: 'Publishing…',
  verify: "Confirming it's live…",
};

const STEP_OP: Record<PublishStepId, StudioOp> = {
  'create-release': 'card.createRelease',
  'request-approval': 'release.requestApproval',
  approve: 'release.approve',
  sign: 'release.sign',
  publish: 'release.publish',
  verify: 'release.verifyPublication',
};

/** Who has to act when the viewer cannot. Named by the DUTY, never by a scope string. */
const WAITING_LINE: Record<PublishStepId, string> = {
  'create-release': 'Waiting for someone who can edit this card.',
  'request-approval': 'Waiting for someone who can edit this card.',
  approve: 'Waiting for someone with approval rights.',
  sign: 'Waiting for someone with signing rights.',
  publish: 'Waiting for someone with publishing rights.',
  verify: 'Waiting for someone with publishing rights.',
};

const TERMINAL: ReadonlySet<CardReleaseState> = new Set(['superseded', 'deprecated', 'revoked']);
const ALL_STEPS: PublishStepId[] = ['create-release', 'request-approval', 'approve', 'sign', 'publish', 'verify'];

/** The ops still needed to take the CURRENT release (or a fresh one) to published+verified. */
export function publishSequence(release: Pick<A2AAgentCardReleaseV1, 'state'> | null, opts: { fresh?: boolean } = {}): PublishStepId[] {
  if (!release || opts.fresh || TERMINAL.has(release.state)) return ALL_STEPS;
  switch (release.state) {
    case 'validated': return ['request-approval', 'approve', 'sign', 'publish', 'verify'];
    case 'approvalPending': return ['approve', 'sign', 'publish', 'verify'];
    case 'approved': return ['sign', 'publish', 'verify'];
    case 'signed': return ['publish', 'verify'];
    case 'published': return [];
    default: return ALL_STEPS;
  }
}

export type PublishPlan =
  /** The description has problems; the button is disabled and says so. Never a 4xx after a click. */
  | { kind: 'blocked'; line: string; fixCount: number }
  /** Nothing to do: the current version is live and the description has not changed since. */
  | { kind: 'live' }
  /** Run `steps` in order; if `stopAt` is set, run the steps before it and then show `stopAt.line`. */
  | { kind: 'ready'; steps: PublishStepId[]; runnable: PublishStepId[]; stopAt: { step: PublishStepId; line: string } | null; asksForBinding: boolean };

export function planPublish(input: {
  draftState: CardDraftState | null;
  errors: number;
  release: Pick<A2AAgentCardReleaseV1, 'state'> | null;
  /** The draft moved past the latest release, so publishing means a NEW version. */
  draftChanged: boolean;
  scopes: readonly string[];
}): PublishPlan {
  if (input.errors > 0) {
    return { kind: 'blocked', fixCount: input.errors, line: `Fix ${input.errors} thing${input.errors === 1 ? '' : 's'} in the description first.` };
  }
  const fresh = input.draftChanged || !input.release || TERMINAL.has(input.release.state);
  if (!fresh && input.release?.state === 'published') return { kind: 'live' };
  const steps = publishSequence(input.release, { fresh });
  let stopAt: { step: PublishStepId; line: string } | null = null;
  const runnable: PublishStepId[] = [];
  for (const s of steps) {
    if (!gateForOp(input.scopes, STEP_OP[s]).allowed) { stopAt = { step: s, line: WAITING_LINE[s] }; break; }
    runnable.push(s);
  }
  return { kind: 'ready', steps, runnable, stopAt, asksForBinding: runnable.includes('sign') };
}

// ── stage ① Describe ─────────────────────────────────────────────────────────────────────────────────────

export interface StageStatus {
  tone: 'good' | 'warn' | 'muted';
  /** The status line at the top-right of the stage card. */
  status: string;
  /** One or two sentences under it: what this stage is, what is true now. */
  body: string;
  /** The single primary action, when there is one. */
  action: { id: 'edit' | 'show-problems' | 'publish' | 'open' | 'republish'; label: string } | null;
}

export function describeStage(input: { draftState: CardDraftState | null; errors: number; checked: boolean; skillCount: number; name: string }): StageStatus {
  const what = `Name, what it does, how to reach it${input.skillCount ? `, and the ${input.skillCount} skill${input.skillCount === 1 ? '' : 's'} it offers` : ''}. Most of this is filled in from the agent's profile — change only what should differ.`;
  if (input.errors > 0) {
    return { tone: 'warn', status: `${input.errors} thing${input.errors === 1 ? '' : 's'} to fix`, body: what, action: { id: 'show-problems', label: 'Show me' } };
  }
  if (!input.checked) {
    return { tone: 'muted', status: 'Filled in from the profile', body: `${what} Review it, or publish as is.`, action: { id: 'edit', label: 'Edit description' } };
  }
  return { tone: 'good', status: 'Ready to publish ✓', body: what, action: { id: 'edit', label: 'Edit description' } };
}

// ── stage ② Make it live ─────────────────────────────────────────────────────────────────────────────────

export function liveStage(input: {
  plan: PublishPlan;
  release: Pick<A2AAgentCardReleaseV1, 'state' | 'publication'> | null;
  cardUri: string | null;
  /** The last publish/verify verdict already in the user's words (`publicationVerdict`). */
  lastVerdict: { title: string } | null;
}): StageStatus & { explain: string } {
  const where = input.cardUri ? input.cardUri.replace('/.well-known/agent-card.json', '') : 'its public address';
  const explain = 'Publishing does not list the agent anywhere — it makes the description available at its address. Listing is step ③.';
  const how = `Publishing puts a signed copy of this description at ${where} — the address other agents use to find and talk to it.`;
  if (!input.cardUri) {
    return { tone: 'muted', status: 'Needs a name first', body: 'This agent has no public name yet, so there is nowhere on the web to publish its card. Give it a name (Manage → Naming); the address follows from the name.', action: null, explain };
  }
  if (input.plan.kind === 'live') {
    const when = input.release?.publication?.publishedAt ? new Date(input.release.publication.publishedAt).toLocaleString() : null;
    return {
      tone: 'good',
      status: 'Live ✓',
      body: input.lastVerdict ? input.lastVerdict.title : `Serving at ${where}${when ? ` since ${when}` : ''}.`,
      action: { id: 'open', label: 'Open' },
      explain,
    };
  }
  if (input.plan.kind === 'blocked') return { tone: 'warn', status: 'Not published yet', body: how, action: null, explain };
  const republish = !!input.release && input.release.state === 'published';
  return {
    tone: 'muted',
    status: republish ? 'A newer version is ready' : 'Not published yet',
    body: republish ? 'The description changed since the live version. Publish again to update what other agents see.' : how,
    action: { id: republish ? 'republish' : 'publish', label: republish ? 'Publish the update' : 'Publish' },
    explain,
  };
}

/** The one prompt the chain stops for: the optional custodian binding (flow-redesign §4). */
export const BINDING_PROMPT = {
  title: 'Sign with your custodian?',
  body: "Your custodian signs once so verifiers can prove this agent authorized the card. Most A2A clients don't need this — you can skip it and add it later.",
  sign: 'Sign with custodian',
  skip: 'Skip for now',
} as const;

// ── what is wrong, in words, on the screen that says something is wrong ──────────────────────────────────
// "2 things to fix" with a Show me that opened an editor taught nothing (product owner, 2026-08-30). The
// problems belong ON the stage, each naming its field and, where we can compute it, offering the fix.

export interface ProblemView {
  message: string;
  /** The field it is about, in the editor's own words. */
  where: string | null;
  pointer?: string;
}

export function problemsFrom(diagnostics: readonly ProjectionDiagnosticV1[]): ProblemView[] {
  return diagnostics
    .filter((d) => d.severity === 'error')
    .map((d) => {
      const v = diagnosticView(d);
      return { message: v.message, where: v.pointer ? fieldNameFor(v.pointer) : null, ...(v.pointer ? { pointer: v.pointer } : {}) };
    });
}

const FIELD_NAMES: Record<string, string> = {
  '/supportedInterfaces': 'How to reach it',
  '/skills': 'Skills',
  '/name': 'Agent name',
  '/description': 'Description',
  '/provider': 'Provider',
  '/securitySchemes': 'Security',
  '/capabilities': 'Capabilities',
};

function fieldNameFor(pointer: string): string {
  for (const [prefix, label] of Object.entries(FIELD_NAMES)) if (pointer === prefix || pointer.startsWith(`${prefix}/`)) return label;
  return pointer.replace(/^\//, '').split('/')[0] ?? 'This field';
}

export interface ServedInterface { url: string; protocolBinding: string }

/**
 * The addresses the RUNNING service says it serves, read out of the divergence messages the validator writes
 * ("catalog interface JSONRPC https://… is missing from the card"). Our own generated text, stable format —
 * but parsed defensively: no match, no offer. This is what makes "the card names an address the agent no
 * longer serves" a one-press fix instead of a hunt (it happens whenever a deployment moves zones).
 */
export function servedInterfacesFrom(diagnostics: readonly ProjectionDiagnosticV1[]): ServedInterface[] {
  const out: ServedInterface[] = [];
  for (const d of diagnostics) {
    if (d.code !== 'CATALOG_DIVERGENCE') continue;
    const m = /catalog interface (\S+) (\S+) is missing/.exec(d.message);
    if (m && m[1] && m[2]) out.push({ protocolBinding: m[1], url: m[2] });
  }
  return out;
}

/** True when every error is "the card's addresses disagree with the running service" — the one-press case. */
export function onlyAddressProblems(diagnostics: readonly ProjectionDiagnosticV1[]): boolean {
  const errors = diagnostics.filter((d) => d.severity === 'error');
  return errors.length > 0 && errors.every((d) => d.code === 'CATALOG_DIVERGENCE' && (d.sourcePointer ?? '').startsWith('/supportedInterfaces'));
}

// ── the cards list (only ever seen when an agent has 0 or 2+ cards) ─────────────────────────────────────

export interface CardRowView {
  /** What this card IS, for a steward scanning several. */
  title: string;
  subtitle: string;
  status: string;
  tone: StageStatus['tone'];
}

export function cardRowView(entry: {
  displayName?: string;
  environment: string;
  primary: boolean;
  draftState: 'clean' | 'dirty' | 'stale' | 'validated' | 'draft' | 'conflict' | null;
  releaseState: string | null;
  servedReleaseId: string | null;
  listedCount: number;
  listedTotal: number;
}): CardRowView {
  const subtitle = [entry.primary ? 'The card other agents see' : 'An additional card', entry.environment === 'production' ? null : entry.environment].filter(Boolean).join(' · ');
  if (entry.releaseState === 'published' || entry.servedReleaseId) {
    const listed = entry.listedTotal === 0 ? '' : entry.listedCount === entry.listedTotal ? ' · listed everywhere' : ` · listed in ${entry.listedCount} of ${entry.listedTotal} places`;
    return { title: entry.displayName ?? 'Agent card', subtitle, status: `Live ✓${listed}`, tone: 'good' };
  }
  if (entry.draftState === 'dirty' || entry.draftState === 'draft') return { title: entry.displayName ?? 'Agent card', subtitle, status: 'Being written', tone: 'muted' };
  if (entry.draftState === 'stale' || entry.draftState === 'conflict') return { title: entry.displayName ?? 'Agent card', subtitle, status: 'Needs a look', tone: 'warn' };
  return { title: entry.displayName ?? 'Agent card', subtitle, status: 'Not live yet', tone: 'muted' };
}

// ── §9.4: the main path never speaks our vocabulary ──────────────────────────────────────────────────────

export const FORBIDDEN_ON_LANDING = ['projection', 'release', 'digest', 'sha256', 'erc-1271', 'erc1271', 'spec ', 'adapter', 'bundle', 'artifact', 'validate', 'card_not_selected'] as const;

/** Every string the landing can show on its main path, for the acceptance test. Details/History/Advanced are exempt. */
export function landingCopySamples(): string[] {
  const out: string[] = [];
  const r = (s: StageStatus & { explain?: string }) => out.push(s.status, s.body, s.action?.label ?? '', s.explain ?? '');
  for (const errors of [0, 1, 3]) for (const checked of [true, false]) r(describeStage({ draftState: 'validated', errors, checked, skillCount: 2, name: 'x' }));
  const plans: PublishPlan[] = [
    { kind: 'blocked', line: 'Fix 2 things in the description first.', fixCount: 2 },
    { kind: 'live' },
    { kind: 'ready', steps: ALL_STEPS, runnable: ALL_STEPS, stopAt: null, asksForBinding: true },
    { kind: 'ready', steps: ALL_STEPS, runnable: [], stopAt: { step: 'approve', line: WAITING_LINE.approve }, asksForBinding: false },
  ];
  for (const plan of plans) {
    r(liveStage({ plan, release: { state: 'published', publication: { uri: 'https://x.example/.well-known/agent-card.json', publishedAt: '2026-08-30T00:00:00Z' } }, cardUri: 'https://x.example/.well-known/agent-card.json', lastVerdict: null }));
    r(liveStage({ plan, release: null, cardUri: null, lastVerdict: null }));
    if (plan.kind === 'blocked') out.push(plan.line);
    if (plan.kind === 'ready' && plan.stopAt) out.push(plan.stopAt.line);
  }
  for (const rs of ['published', null]) for (const ds of ['dirty', 'stale', null] as const) {
    const v = cardRowView({ displayName: 'Alice', environment: 'production', primary: true, draftState: ds, releaseState: rs, servedReleaseId: null, listedCount: 1, listedTotal: 2 });
    out.push(v.title, v.subtitle, v.status);
  }
  out.push(...Object.values(PUBLISH_PHRASE), ...Object.values(WAITING_LINE), ...Object.values(BINDING_PROMPT));
  return out.filter(Boolean);
}
