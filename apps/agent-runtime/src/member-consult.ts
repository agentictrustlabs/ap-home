// FAN-OUT CONSULT (spec 380, appendix M5): an organization asks EACH of its members the same question
// through the consult rail (spec 329) — one step per member, run at the organization's own agent, each
// member's agent answering under ITS OWN playbook and ITS OWN consultability grant. No shared transcript
// and no selector model choosing who speaks: N steps, N receipts, and one composed answer whose evidence
// names each source. A member who has not opted in is SKIPPED — and the skip is a result with a receipt,
// never a failure of the plan and never a reason to ask anyway.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import type { Hex } from 'viem';
import type { Env } from './index.js';
import { awaitConsult, memberConsultGrant, orgConsultWire, submitConsult, type RawSigner } from './consult-rail.js';

export const MEMBER_CONSULT_CAPABILITY = 'organization.member.consult' as const;

/** How long one member's agent gets to answer inside a run — the consult turn is one model call. */
export const HARNESS_CONSULT_DEADLINE_MS = 45_000;

export const MEMBER_CONSULT_TOOL: ToolSpec = {
  id: MEMBER_CONSULT_CAPABILITY,
  answers: ['what members say', 'what each member says', 'what the members said', 'what members answered', 'availability of members'],
  // The imperatives that name a consultation of the members (spec 379's rule: a read may claim a verb).
  verbs: ['ask each', 'ask every', 'ask all', 'consult', 'poll', 'survey'],
  description:
    'ASKS ONE MEMBER OF AN ORGANIZATION A QUESTION through their own agent, which answers (or declines) under '
    + 'that member\'s own playbook and only if the member has opted in to being consulted by this organization. '
    + 'Used once per member, after organization.membership.list enumerates them (forEach over roster.members). '
    + 'A member who has not opted in is skipped, and the skip is reported. Args: org (the organization, exactly '
    + 'as the ask names it), respondent (the member being asked — their agent address, from the roster), question (what to ask, in plain words).',
  inputSchema: {
    type: 'object',
    properties: {
      org: { type: 'string', description: 'The organization whose member is asked — a name or an address, exactly as the ask says it.' },
      respondent: { type: 'string', description: 'The member being asked — their agent address (from the roster).' },
      question: { type: 'string', description: 'The question, in plain words.' },
    },
    required: ['org', 'respondent', 'question'],
  },
  // The organization ANSWERS for a consult of its own members: asked at a person's agent, the step routes
  // to the organization's agent (spec 366); asked at the organization, it runs here.
  subject: 'org',
};

/** "ask each member of Missio Nexus whether they are available on Saturday" → the organization phrase and the
 *  question clause. Null for anything that is not a consult of the members. */
export function consultAskOf(goal: string): { org?: string; question: string } | null {
  const m = goal.match(
    /^\s*(?:please\s+)?(?:ask|consult|poll|survey)\s+(?:each|every|all(?:\s+of)?(?:\s+the)?|the)\s+members?\b(?:\s+(?:of|in|on)\s+(?:the\s+)?(.+?))?\s*(?:[,:]\s*|\s+(?=(?:whether|if|what|when|where|how|who|which|about|to)\b))(.+?)\s*[?.!]*$/i,
  );
  if (!m) return null;
  const raw = (m[1] ?? '').replace(/\s+(organization|organisation|org|team|workspace|circle|church|group)$/i, '').trim();
  // A pronoun or a bare generic noun names nothing — "the members of my team" means the agent being asked.
  const org = raw && !/^(it|this|that|there|here|my|our|your|their|the|org|organization|team|workspace|circle|church|group)$/i.test(raw) ? raw : '';
  const question = (m[2] ?? '').trim();
  if (!question) return null;
  return { ...(org ? { org } : {}), question };
}

export interface MemberConsultDeps {
  nameOf?: (address: string) => Promise<string | null>;
  deadlineMs?: number;
  /** The org-side raw signer (tests only; the Worker uses the interactions-session key). */
  signRaw?: RawSigner;
  everyMs?: number;
}

/** The consult step's invoker, run AT THE ORGANIZATION. */
export function memberConsultInvoker(env: Env, deps: MemberConsultDeps = {}): ToolInvoker {
  return async (_toolId, args, ctx) => {
    const org = String(args.org ?? '').trim().toLowerCase();
    const member = String(args.respondent ?? '').trim().toLowerCase();
    const question = String(args.question ?? '').trim();
    if (!/^0x[0-9a-f]{40}$/.test(org)) return { refused: 'the organization must be resolved to its address before its members can be consulted', interpretation: 'no organization address' };
    if (!/^0x[0-9a-f]{40}$/.test(member)) return { refused: `respondent must be a member's agent address (got "${String(args.respondent ?? '')}")`, interpretation: 'no member address' };
    if (!question) return { refused: 'a question is required', interpretation: 'no question' };
    const name = (await deps.nameOf?.(member).catch(() => null)) ?? null;
    const who = name ? `${name} (${member.slice(0, 8)}…)` : member;
    // THE MEMBER'S OWN OPT-IN, read fresh (spec 329 §8). Absent ⇒ skipped, said, and recorded — the plan
    // goes on; nothing is asked of an agent whose person did not consent to this organization asking.
    const grant = await memberConsultGrant(env, org, member);
    if (!grant) {
      return {
        consulted: false, skipped: true, member, ...(name ? { name } : {}), attributedTo: member,
        reason: `${who} has not opted in to being consulted by this organization — not asked`,
        interpretation: `skipped ${who}: no consultability grant to this organization`,
        note: 'Say this member was not asked and why; never guess what they would have said.',
      };
    }
    const orgWire = await orgConsultWire(env, org);
    if (!orgWire) {
      return { refused: 'this organization cannot consult its members yet — a steward has not enabled member routing (the consult wire is not minted)', interpretation: 'no org consult wire' };
    }
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    const runRef = String((ctx.intent.context as { runRef?: unknown } | undefined)?.runRef ?? 'run');
    const topicId = `harness:${runRef}`;
    const questionId = `${runRef}:${stepRef}`;
    let taskId: Hex;
    try {
      ({ taskId } = await submitConsult(env, { org, orgWire, grant, memberSA: member, question, topicId, questionId, topicTitle: 'a question from the organization', ...(deps.signRaw ? { signRaw: deps.signRaw } : {}) }));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // THE MEMBER'S GATE SAID NO — that is the member's result (spec 380 §1: a refusal is a result), not a
      // failure of the plan: recorded, said, and the other members' answers stand.
      return { consulted: false, member, ...(name ? { name } : {}), attributedTo: member, gateRefused: error, reason: `${who}'s agent did not take the question: ${error}`, interpretation: `asked ${who}'s agent; its gate refused: ${error}`, note: 'Say this member\'s agent did not take the question and why; never guess what they would have said.' };
    }
    const got = await awaitConsult(env, { org, orgWire, memberSA: member, taskId, deadlineMs: deps.deadlineMs ?? HARNESS_CONSULT_DEADLINE_MS, ...(deps.everyMs ? { everyMs: deps.everyMs } : {}), ...(deps.signRaw ? { signRaw: deps.signRaw } : {}) });
    const base = { consulted: true, member, ...(name ? { name } : {}), attributedTo: member, taskId, note: `Said by ${who}'s own agent under their own playbook — say who said it; it is their agent's words, not a fact of this organization's.` };
    if (got.state === 'answered') return { ...base, answer: got.answer, interpretation: `asked ${who}'s agent “${question}” — it answered` };
    if (got.state === 'declined') return { ...base, declined: true, ...(got.reason ? { reason: got.reason } : {}), interpretation: `asked ${who}'s agent “${question}” — it declined${got.reason ? `: ${got.reason}` : ''}` };
    if (got.state === 'pending') return { ...base, consulted: false, pending: true, reason: `${who}'s agent had not answered within ${Math.round((deps.deadlineMs ?? HARNESS_CONSULT_DEADLINE_MS) / 1000)}s`, interpretation: `asked ${who}'s agent — no answer yet (task ${got.taskState})` };
    return { ...base, consulted: false, refused: `${who}'s agent failed to answer: ${got.error}`, interpretation: `asked ${who}'s agent — it failed: ${got.error}` };
  };
}
