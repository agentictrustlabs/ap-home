// The Agent Card page, as pure logic (flow-redesign.md §2–§4, §7, §9).
//
// The page is one thing: this agent's card. You edit the description and you SAVE it, and the two public
// addresses then serve what you saved. `[Save]` runs the whole release chain — validate, freeze, approve,
// sign, put it at the address, check what the address returns — as a single busy action, because those are
// steps in making a save trustworthy, not six things a person set out to do.
//
// It used to read as "① Describe → ② Make it live" with a promised "step ③" for listing. That was true
// when this page also owned the listings as tabs; they are their own left-nav destinations now, so ③
// pointed at nothing and the numbering implied a sequence with a missing end (owner, 2026-08-31).
//
// This module decides which ops run, in which order, what the button says while they run, and where the
// chain must STOP because a different person has to act. No React, no I/O: every sentence a steward reads
// is assembled here so a test can prove the main path never uses our vocabulary (§9.4).
import type { A2AAgentCardReleaseV1, CardDraftState, CardReleaseState } from '@agenticprimitives/agent-profile/a2a';
import { diagnosticView, gateForOp, type StudioOp } from './studio-view';
import type { ProjectionDiagnosticV1 } from '@agenticprimitives/types';

// ── the publish chain ────────────────────────────────────────────────────────────────────────────────────

export type PublishStepId = 'create-release' | 'request-approval' | 'approve' | 'sign' | 'publish' | 'verify';

/** What the busy button says during each step — the user's words, not the state machine's. */
export const PUBLISH_PHRASE: Record<'check' | 'adoptEndpoint' | PublishStepId, string> = {
  check: 'Checking the description…',
  'create-release': 'Saving…',
  'request-approval': 'Saving…',
  approve: 'Saving…',
  sign: 'Signing it…',
  publish: 'Putting it at the address…',
  verify: 'Checking what the address serves…',
  // Saving a card also points the NAME at it when the name has no endpoint yet — one save, not two.
  adoptEndpoint: 'Pointing your name at it…',
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
  publish: 'Waiting for someone who can put this at its public address.',
  verify: 'Waiting for someone who can put this at its public address.',
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
  /** The live version was published at a DIFFERENT address than the one this agent answers at now (a zone
   *  move). Nothing in the card changed, but what the world was told is out of date — so publishing is the
   *  fix, and without this there is no way to ask for it. */
  addressMoved?: boolean;
  scopes: readonly string[];
}): PublishPlan {
  if (input.errors > 0) {
    return { kind: 'blocked', fixCount: input.errors, line: `Fix ${input.errors} thing${input.errors === 1 ? '' : 's'} in the description first.` };
  }
  const fresh = input.draftChanged || input.addressMoved === true || !input.release || TERMINAL.has(input.release.state);
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

// ── saving ───────────────────────────────────────────────────────────────────────────────────────────────
// This page used to read as two numbered stages — "① Describe your agent" then "② Make it live" — and
// promised a "step ③" for listing. Both were true when the card page also owned the listings as tabs.
// They are their own left-nav destinations now, so ③ pointed at nothing and the numbering implied a
// sequence with a missing end.
//
// What is actually happening is simpler, and the owner named it: you EDIT the card and you SAVE it, and
// the two public addresses then serve what you saved. Signing is part of saving, not a stage of its own —
// the signature is how a save is made trustworthy, not a separate thing the person set out to do.
//
// So there is one status here, and it answers one question: is what the world can read the same as what
// is on this screen?

export type SaveState = StageStatus & {
  /** The one line under the status that says what saving does and does not do. */
  explain: string;
  /** What the public addresses are serving RIGHT NOW, relative to what is on screen. */
  serving: 'nothing' | 'this' | 'older' | 'elsewhere';
};

export function saveState(input: {
  plan: PublishPlan;
  release: Pick<A2AAgentCardReleaseV1, 'state' | 'publication'> | null;
  cardUri: string | null;
  /** The last save verdict already in the user's words (`publicationVerdict`). */
  lastVerdict: { title: string } | null;
  /** The live copy sits at a DIFFERENT address than the one this agent answers at now (a zone move). */
  publishedAtOldAddress?: string | null;
}): SaveState {
  const explain = 'Saving signs this description and puts it at the addresses below. It does not list the agent in any directory — that is Registry.';

  if (!input.cardUri) {
    return {
      tone: 'muted',
      status: 'Needs a name first',
      body: 'This agent has no public name yet, so there is nowhere to serve its card from — the address comes from the name. Give it one under Naming, then save.',
      action: null,
      explain,
      serving: 'nothing',
    };
  }

  if (input.publishedAtOldAddress) {
    const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };
    return {
      tone: 'warn',
      status: 'Saved at an old address',
      body: `What is saved sits at ${host(input.publishedAtOldAddress)}, but this agent now answers at ${host(input.cardUri)}. Saving again moves it to where the agent actually is.`,
      action: { id: 'republish', label: 'Save at the new address' },
      explain,
      serving: 'elsewhere',
    };
  }

  if (input.plan.kind === 'live') {
    const at = input.release?.publication?.publishedAt;
    const when = at ? new Date(at).toLocaleString() : null;
    return {
      tone: 'good',
      status: 'Saved ✓',
      body: input.lastVerdict
        ? input.lastVerdict.title
        : `The addresses below are serving this description${when ? `, saved ${when}` : ''}.`,
      action: null,
      explain,
      serving: 'this',
    };
  }

  const saved = !!input.release && input.release.state === 'published';
  if (input.plan.kind === 'blocked') {
    return {
      tone: 'warn',
      status: saved ? 'Unsaved changes' : 'Not saved yet',
      body: saved
        ? 'Fix what is flagged above and save — until then the addresses keep serving the last saved version.'
        : 'Fix what is flagged above, then save to put this description at the addresses below.',
      action: null,
      explain,
      serving: saved ? 'older' : 'nothing',
    };
  }
  return {
    tone: 'muted',
    status: saved ? 'Unsaved changes' : 'Not saved yet',
    body: saved
      ? 'This description has changed since it was last saved. The addresses below still serve the previous version.'
      : 'Nothing is being served yet. Saving signs this description and puts it at the addresses below, so other agents can read it.',
    action: { id: saved ? 'republish' : 'publish', label: saved ? 'Save changes' : 'Save' },
    explain,
    serving: saved ? 'older' : 'nothing',
  };
}

// ── what a live agent actually serves ────────────────────────────────────────────────────────────────────
// Publishing puts TWO documents at the agent's address, and a steward should be able to open both: the card
// itself, and the one-line entry that points at it so crawlers and directories can find it without being told.
// Named by what they are, with the standard each one follows shown as a link for whoever needs it.

export interface PublicEndpoint {
  id: 'card' | 'entry';
  label: string;
  what: string;
  url: string;
  standard: string;
  standardUrl: string;
}

export const A2A_STANDARD_URL = 'https://a2a-protocol.org/latest/specification/';
export const ARD_STANDARD_URL = 'https://agenticresourcediscovery.org/spec/';

/** `cardUri` is `https://<host>/.well-known/agent-card.json`; both documents sit on that host. */
export function publicEndpoints(cardUri: string | null): PublicEndpoint[] {
  if (!cardUri) return [];
  let origin: string;
  try { origin = new URL(cardUri).origin; } catch { return []; }
  return [
    {
      id: 'card',
      label: 'Agent card',
      what: 'What this agent is, what it can do, and how to talk to it.',
      url: `${origin}/.well-known/agent-card.json`,
      standard: 'A2A 1.0',
      standardUrl: A2A_STANDARD_URL,
    },
    {
      id: 'entry',
      label: 'Discovery entry',
      what: 'A short entry pointing at the card, so crawlers and directories can find this agent without being told about it.',
      url: `${origin}/.well-known/ard.json`,
      standard: 'ARD 0.91',
      standardUrl: ARD_STANDARD_URL,
    },
  ];
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
    r(saveState({ plan, release: { state: 'published', publication: { uri: 'https://x.example/.well-known/agent-card.json', publishedAt: '2026-08-30T00:00:00Z' } }, cardUri: 'https://x.example/.well-known/agent-card.json', lastVerdict: null }));
    r(saveState({ plan, release: null, cardUri: null, lastVerdict: null }));
    if (plan.kind === 'blocked') out.push(plan.line);
    if (plan.kind === 'ready' && plan.stopAt) out.push(plan.stopAt.line);
  }
  for (const rs of ['published', null]) for (const ds of ['dirty', 'stale', null] as const) {
    const v = cardRowView({ displayName: 'Alice', environment: 'production', primary: true, draftState: ds, releaseState: rs, servedReleaseId: null, listedCount: 1, listedTotal: 2 });
    out.push(v.title, v.subtitle, v.status);
  }
  for (const e of publicEndpoints('https://x.example/.well-known/agent-card.json')) out.push(e.label, e.what, e.standard);
  out.push(...Object.values(PUBLISH_PHRASE), ...Object.values(WAITING_LINE), ...Object.values(BINDING_PROMPT));
  return out.filter(Boolean);
}
