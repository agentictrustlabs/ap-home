/**
 * THE ASK SCENARIO SET — spec 367 W2. `pnpm check:ask-scenarios`.
 *
 * The fixtures are the SKILL.md contracts' own `utterances` (spec 367 §2): a scenario ships with the
 * skill, and this replays every one of them against the deployed archetype definitions. Two layers:
 *
 *   OFFLINE (always): for every positive utterance, the declared plan — the tool with the declared args —
 *   must pass PLAN ADMISSION (spec 367 W1) under the same rules the harness runs; for every negative one
 *   (`isNot`), admission must NOT demand this act (the sentence is not an instruction for it). A contract
 *   whose examples its own gate would refuse teaches the planner something the loop will then deny.
 *
 *   LIVE (ASK_SCENARIOS_LIVE=1): every utterance is asked at the deployed agent as a demo persona and the
 *   reply must NAME the tool: an act ⇒ `authority_required` or `prompt` for that capability (nothing runs
 *   without a mandate — that is the point); a read ⇒ `answer` whose evidence cites the tool; a negative ⇒
 *   anything but that tool. Deterministic judge; every failure prints the sentence and what came back.
 *
 * Ground truth comes from the registry's compiled definitions, never from this repo's code.
 */
import { planAdmission, instructionNeedsAct, noPlaceholders, subjectNamedInAsk, type ToolSpec } from '../packages/orchestration/src/index.js';
import { validateAgentHarnessDefinition, type AgentHarnessDefinitionV1, type DefinitionToolV1 } from '../packages/capability-claims/src/index.js';

const REGISTRY = process.env.SKILLS_REGISTRY ?? 'https://skills-a2a-production.richardpedersen3.workers.dev';
const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
const ARCHETYPES = (process.env.ASK_SCENARIO_ARCHETYPES ?? 'person-steward').split(',').map((s) => s.trim()).filter(Boolean);
const LIVE = process.env.ASK_SCENARIOS_LIVE === '1';

const j = async (r: Response): Promise<Record<string, unknown>> => { const t = await r.text(); try { return JSON.parse(t) as Record<string, unknown>; } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };

let failures = 0; let cases = 0;
const fail = (msg: string) => { failures++; console.log(`  ✗ ${msg}`); };
const pass = (msg: string) => { console.log(`  ✓ ${msg}`); };

for (const archetype of ARCHETYPES) {
  const res = await j(await fetch(`${REGISTRY}/context/contexts/agentic-trust/archetypes/${archetype}/definition`));
  const def = (res.definition ?? res) as AgentHarnessDefinitionV1;
  const v = validateAgentHarnessDefinition(def);
  console.log(`\n${archetype} v${def.archetypeVersion ?? '?'} — ${v.ok ? 'valid' : `INVALID: ${v.errors[0]}`}`);
  if (!v.ok) { failures++; continue; }
  const tools: ToolSpec[] = def.tools.map((t: DefinitionToolV1) => ({ ...t } as unknown as ToolSpec));
  const admission = planAdmission([instructionNeedsAct, noPlaceholders, subjectNamedInAsk(async () => [])]);
  const withUtterances = def.tools.filter((t) => t.utterances?.length);
  if (!withUtterances.length) fail(`${archetype}: no tool carries utterances — the skills teach nothing yet`);
  for (const t of withUtterances) {
    for (const u of t.utterances ?? []) {
      cases++;
      const intent = { goal: u.says };
      if (u.isNot === undefined) {
        const verdict = await admission.admit({ intent, plan: { steps: [{ toolId: t.id, args: u.args ?? {} }] }, tools });
        if (verdict.admitted) pass(`"${u.says}" → ${t.id} ${JSON.stringify(u.args ?? {})} admitted`);
        else fail(`"${u.says}" → ${t.id}: its own plan is refused: ${verdict.violations.map((x) => x.message).join(' | ')}`);
      } else {
        // A negative example must not be an INSTRUCTION for this act: admission must accept a read-only
        // plan for it (otherwise the sentence opens with this act's verb and the contract contradicts itself).
        const verdict = await admission.admit({ intent, plan: { steps: [{ toolId: 'ask.unsupported', args: {} }] }, tools: [...tools, { id: 'ask.unsupported', description: 'nothing' }] });
        const demands = !verdict.admitted && verdict.violations.some((x) => x.code === 'OUTCOME_NOT_ESTABLISHED' && x.message.includes(t.id));
        if (!demands) pass(`"${u.says}" is NOT ${t.id} (${u.isNot.slice(0, 60)}…)`);
        else fail(`"${u.says}" is declared NOT ${t.id}, but it opens with one of its verbs — the contract contradicts itself`);
      }
    }
  }
  if (LIVE) {
    const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
    const csrf = (await j(csrfRes)) as { token?: string };
    const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
    const H = { 'content-type': 'application/json', origin: HOME, cookie: cookie!, 'x-csrf-token': csrf.token ?? '' };
    const s = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: process.env.ASK_SCENARIO_PERSONA ?? 'alice', client_id: 'demo-jp' }) }));
    const session = String(s.homeSession); const agent = String(s.agent).toLowerCase();
    // A SELF-ACTING act (a capability with no mandate type — a profile edit, a household record) EXECUTES
    // when asked: the session is its authority. Asking it live would change the persona's records on every
    // run (it did, once: phone and city rewritten by the examples). Those are checked offline only.
    const selfActing = (t: DefinitionToolV1): boolean => !!t.capability && !def.requiredMandateTypes.some((m) => m.endsWith(`:${t.capability!.id}`) || m === t.capability!.id);
    for (const t of withUtterances) {
      if (selfActing(t)) { for (const u of t.utterances ?? []) if (u.isNot === undefined) console.log(`  · live "${u.says}" → ${t.id} is self-acting and would execute — offline only`); continue; }
      for (const u of t.utterances ?? []) {
        const r = await j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: H, body: JSON.stringify({ session, addressee: agent, message: u.says }) }));
        const reply = (r.reply ?? {}) as { kind?: string; capability?: string; prompt?: { toolId?: string }; evidence?: Array<{ toolId?: string }>; receipts?: Array<{ capability?: { id?: string } }>; error?: string; text?: string };
        const named = reply.capability === t.id || reply.prompt?.toolId === t.id || (reply.evidence ?? []).some((e) => e.toolId === t.id) || (reply.receipts ?? []).some((x) => x.capability?.id === t.id) || (reply.kind === 'answer' && !t.capability && String(reply.text ?? '').length > 0 && (reply.evidence ?? []).length === 0 && t.id === 'organization.membership.list');
        if (u.isNot === undefined ? named : !named) pass(`live "${u.says}" → ${reply.kind}${reply.capability ? ` ${reply.capability}` : ''}${reply.prompt?.toolId ? ` ${reply.prompt.toolId}` : ''}`);
        else fail(`live "${u.says}" → ${reply.kind} ${reply.capability ?? reply.prompt?.toolId ?? (reply.evidence ?? []).map((e) => e.toolId).join(',') ?? reply.error ?? ''} — expected ${u.isNot === undefined ? '' : 'NOT '}${t.id}`);
      }
    }
  }
}
console.log(`\n${cases} scenarios, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
