// The demo-a2a binding of the Ring-0 agentic loop (ADR-0044). ONE definition of the agent's exposed tools +
// the planner selection + the run, shared by the two first-party entry points:
//   • the A2aTaskDO `orchestrate` SkillHandler (the canonical TASK path: a real A2A message/send → task →
//     orchestrate → tasks/get), used by agent-to-agent intents through /api/a2a; and
//   • the `/a2a/intent` relayer endpoint (the session-bridged first-party convenience for the simple demo-web,
//     where the browser holds a server-side session rather than a signable A2A message).
// Both run the IDENTICAL orchestration core over a delegation-bound invoker — the planner chooses WHICH tool;
// every composed MCP call rides the supplied delegation (authority unchanged, ADR-0041).
import { runIntent, createRuleBasedPlanner, type Planner, type ToolSpec, type ToolInvoker, type RunResult } from '@agenticprimitives/orchestration';
import { createAnthropicPlanner, createFetchAnthropicClient } from '@agenticprimitives/orchestration-anthropic';
import type { Address } from 'viem';
// Type-only import (erased at build — no runtime cycle with index.ts).
import type { Env } from './index.js';

/** The MCP tools this agent may COMPOSE to satisfy an intent. Ids are exactly the delegation-gated demo-mcp
 *  tools (`callMcpToolViaDelegation`). The web posts a GOAL; the planner picks among THESE. */
export const ORCHESTRATION_TOOLS: ToolSpec[] = [
  {
    id: 'get_profile',
    description:
      "Read the principal's profile (name, email, phone) — the default for \"read/show my profile\". Returns the seeded demo profile. Needs no arguments.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    id: 'get_vault_record',
    description:
      "Read one of the principal's private vault records by recordType (e.g. \"impact-profile\" for their profile). Use this to read the user's own stored data.",
    inputSchema: {
      type: 'object',
      properties: { recordType: { type: 'string', description: 'The record type to read, e.g. "impact-profile".' } },
      required: ['recordType'],
    },
  },
  {
    id: 'list_vault_record',
    description: "List the recordTypes the principal has stored in their vault. Use this when the user asks what data they have.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    id: 'get_pii',
    description:
      "Read the principal's personal identifying information (PII — high sensitivity). Use this only when the user explicitly asks for their personal/identity details.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    id: 'get_org_sensitive',
    description:
      "Read the ORGANIZATION's gated/sensitive data (when the principal is an org Smart Agent). Use this for \"read my org/organization details\".",
    inputSchema: { type: 'object', properties: {} },
  },
];

/** The deterministic default planner (no model, no creds) — the LIVE default. Maps a goal → a plan. */
const RULE_BASED_PLANNER: Planner = createRuleBasedPlanner([
  // MULTI-STEP: "show me everything / all my data" → list the vault, then read the FIRST record the list
  // returns. Step 2's recordType is threaded from step 1's result via a path $ref (the loop resolves
  // `list.record_types.0.record_type`). Exercises the loop's multi-step composition + $ref threading live.
  {
    match: /\b(everything|all my data|all my records|summar)/,
    steps: [
      { toolId: 'list_vault_record', args: {}, ref: 'list' },
      { toolId: 'get_vault_record', args: { recordType: { $ref: 'list.record_types.0.record_type' } } },
    ],
  },
  // "read my profile / personal info" → get_pii. get_pii uses readSensitive (entitlement→KAS→audit→decrypt)
  // and works for any person SA; get_profile needs a per-person vault-key binding (spec 278) the simple flow
  // never creates (it returns vault_key_unauthorized), so it is NOT the default — it stays an exposed tool a
  // binding-holding caller (e.g. via demo-sso) or the LLM planner may still select.
  { match: /\b(org|organization|organisation)\b/, toolId: 'get_org_sensitive' },
  { match: /\b(profile|pii|personal|identity|who am i)\b/, toolId: 'get_pii' },
  // App-driven vault ops (demo-gs/jp operational reads): EXPLICIT, collision-free goals that carry the exact
  // recordType verbatim (no fuzzy keyword matching — recordTypes can be anything: hyphens, colons, prefixes).
  // These are intent-shaped + ride the custody-agnostic delegation, but the recordType is app-known, so the
  // goal names it precisely rather than relying on the NL planner to guess.
  {
    match: /^read vault record /i,
    toolId: 'get_vault_record',
    args: (goal) => ({ recordType: goal.replace(/^read vault record /i, '').trim() }),
  },
  { match: /^list vault records$/i, toolId: 'list_vault_record' },
  { match: /\b(list|which records|what records|my records|records)\b/, toolId: 'list_vault_record' },
  // A bare "read my <recordType>" fallback → vault read of that record type (NL convenience).
  {
    match: /\bread my (\w[\w-]*)/,
    toolId: 'get_vault_record',
    args: (goal) => ({ recordType: /\bread my (\w[\w-]*)/.exec(goal.toLowerCase())?.[1] ?? 'impact-profile' }),
  },
]);

/** The env subset the planner selection needs. */
export type PlannerEnv = Pick<Env, 'ORCHESTRATION_LLM' | 'ANTHROPIC_API_KEY' | 'ORCHESTRATION_MODEL'>;

/** Select the planner per env: the Anthropic LLM planner when explicitly enabled + keyed, else deterministic. */
export function selectPlanner(env: PlannerEnv): { planner: Planner; kind: 'anthropic' | 'rule-based' } {
  if (env.ORCHESTRATION_LLM === 'anthropic' && env.ANTHROPIC_API_KEY) {
    const client = createFetchAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY });
    const planner = env.ORCHESTRATION_MODEL
      ? createAnthropicPlanner({ client, model: env.ORCHESTRATION_MODEL })
      : createAnthropicPlanner({ client });
    return { planner, kind: 'anthropic' };
  }
  return { planner: RULE_BASED_PLANNER, kind: 'rule-based' };
}

/** Run an intent through the shared orchestration core. `invoke` is the delegation-bound MCP composer (the
 *  authority boundary) — the caller supplies it (the skill wraps `ctx.mcp.callTool`; the relayer wraps
 *  `callMcpToolViaDelegation`). Returns the run result + which planner ran. */
export async function runOrchestration(
  env: PlannerEnv,
  args: { goal: string; principal: Address; invoke: ToolInvoker },
): Promise<{ result: RunResult; plannerKind: 'anthropic' | 'rule-based' }> {
  const { planner, kind } = selectPlanner(env);
  const result = await runIntent(
    { goal: args.goal, context: { principal: args.principal } },
    { planner, tools: ORCHESTRATION_TOOLS, invoke: args.invoke },
  );
  return { result, plannerKind: kind };
}
