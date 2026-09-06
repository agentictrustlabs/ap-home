// ASKING YOUR OWN VAULT A QUESTION — spec 356 W2, with the §2.5 survey.
//
// A person's Home lists their records faithfully and uselessly: a hundred keys like
// `coordination.endeavor:end_05b5…` with a `show` link beside each. "What am I working on" is answerable
// from those records and was answerable by nobody, because nothing connected the KEYS to the vocabulary
// the question is asked in.
//
// TWO PHASES, AND THE ORDER IS THE POINT:
//
//   SURVEY  — `list` returns record keys and timestamps. No ciphertext is touched. Each key is bound to
//             an ontology class (spec 356 §2.1), so the shape of the vault is legible before anything is
//             opened: "11 endeavors, 1 roster, 40 artifacts".
//   DECODE  — only the candidates are read, in ONE batched call. Not every record of a class, and never
//             the whole vault: the difference between three reads and forty.
//
// The alternative — read everything and filter in the agent — is refused by spec 356 §2.3. It moves a
// person's whole record set into a service that has no business holding it, turns one authorization into
// hundreds, and scales exactly backwards.
//
// WHOSE VAULT. W2 is the ASKER'S OWN, and only theirs. Reading a vault they hold a delegation for is W3,
// and it is a different authority question — not a bigger loop around the same one. The subject here is
// the connected person, taken from the session and never from an argument.
//
// AUTHORITY. Unchanged and not ours: every read rides the principal's own interactions grant, per-record
// scope enforced where it always was (spec 277, ADR-0041). Choosing a record authorizes nothing.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { createFetchAnthropicClient, type AnthropicLike } from '@agenticprimitives/orchestration-anthropic';
import { bindingForRecordType, askableRecordKinds, recordTypesForClass } from '@agenticprimitives/ontology';

export const VAULT_QUESTION_TOOL: ToolSpec = {
  id: 'vault.records.query',
  description:
    'ANSWERS A QUESTION ABOUT THE ASKER\'S OWN PRIVATE RECORDS — what they are working on, what they have '
    + 'been sent, what they hold. Use this for "what am I working on", "what endeavors do I have", "what '
    + 'artifacts are in my vault", "what requests am I waiting on". '
    + 'It reads the ASKER\'S OWN vault only — never another agent\'s, never an organization\'s roster, and '
    + 'never the public directory (use find_agents / kb.question for anything public). '
    + 'It READS ONLY: it never sends, pays, creates or changes anything. '
    + 'Args: question (in plain words).',
  inputSchema: {
    type: 'object',
    properties: { question: { type: 'string', description: 'The question about your own records, in plain words.' } },
    required: ['question'],
  },
};

export interface VaultQuestionDeps {
  /** The inventory: record keys + timestamps, no plaintext (§2.5 phase one). */
  survey?: (subject: string) => Promise<Array<{ recordType: string; updatedAt?: string }>>;
  /** The decode: exactly these keys, one batched call (§2.5 phase two). */
  readRecords?: (subject: string, recordTypes: string[]) => Promise<Record<string, unknown>>;
}

export interface VaultQuestionEnv {
  ORCHESTRATION_LLM?: string;
  ANTHROPIC_API_KEY?: string;
  ORCHESTRATION_MODEL?: string;
}

/** Offered only where the survey can be read AND a model can choose from it. Absent either, the tool is
 *  not listed — a listed tool the agent cannot run is a step that fails after the planner picks it. */
export function vaultQuestionAvailable(env: VaultQuestionEnv, deps: VaultQuestionDeps): boolean {
  return env.ORCHESTRATION_LLM === 'anthropic' && !!env.ANTHROPIC_API_KEY && !!deps.survey && !!deps.readRecords;
}

/** The survey, as a person would read it: what is in there, by kind. Unbound keys are reported as
 *  `unclassified` rather than dropped — a record nothing binds is still a record they have, and hiding it
 *  would make the ontology's coverage look complete when it is not. */
export function surveyByKind(records: Array<{ recordType: string }>): Array<{ kind: string; class?: string; count: number; examples: string[] }> {
  const groups = new Map<string, { kind: string; class?: string; count: number; examples: string[] }>();
  for (const r of records) {
    const b = bindingForRecordType(r.recordType);
    const key = b?.class ?? 'unclassified';
    const g = groups.get(key) ?? { kind: b?.plural ?? 'unclassified records', ...(b ? { class: b.class } : {}), count: 0, examples: [] };
    g.count += 1;
    if (g.examples.length < 3) g.examples.push(r.recordType);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

const SELECT_TOOL = {
  name: 'choose_records',
  description: 'Choose which of the listed records to open in order to answer the question.',
  input_schema: {
    type: 'object',
    properties: {
      interpretation: { type: 'string', description: 'What you understood the question to be asking, in one sentence.' },
      recordTypes: { type: 'array', items: { type: 'string' }, description: 'The exact record keys to open. Empty if none of them can answer it.' },
    },
    required: ['interpretation', 'recordTypes'],
  },
} as const;

/**
 * Ask the model WHICH records could answer — over the inventory, never over content.
 *
 * It sees keys, kinds and counts. It does not see a single decrypted record, because nothing has been
 * decrypted yet: that is the whole point of doing this before the read rather than after it.
 */
async function chooseRecords(
  client: AnthropicLike, model: string, question: string,
  survey: Array<{ recordType: string; updatedAt?: string }>,
): Promise<{ interpretation: string; recordTypes: string[] }> {
  const byKind = surveyByKind(survey);
  const system = [
    "You are choosing which of a person's OWN private records to open to answer their question.",
    'You are shown the INVENTORY only — record keys and what kind of thing each is. Nothing has been',
    'decrypted, and you are not being asked what the records say.',
    '',
    'WHAT IS IN THIS VAULT:',
    ...byKind.map((g) => `  ${g.count.toString().padStart(4)} × ${g.kind}${g.class ? ` (${g.class})` : ''} — e.g. ${g.examples.join(', ')}`),
    '',
    'EVERY RECORD KEY:',
    ...survey.slice(0, 400).map((r) => `  ${r.recordType}${r.updatedAt ? `  (updated ${r.updatedAt})` : ''}`),
    '',
    'RULES:',
    '  - Choose the FEWEST keys that can answer the question. Opening a record is a real read of private data.',
    '  - Choose EXACT keys from the list. A key that is not listed does not exist.',
    '  - At most 25.',
    '  - If nothing listed can answer it, return an empty list and say so in `interpretation`. That is a',
    '    better answer than opening records at random.',
  ].join('\n');
  const res = await client.messages.create({
    model, max_tokens: 1200, system,
    messages: [{ role: 'user', content: question }],
    tools: [SELECT_TOOL as never], tool_choice: { type: 'tool', name: 'choose_records' },
  });
  const block = res.content.find((b) => b.type === 'tool_use' && b.name === 'choose_records');
  const input = (block?.input ?? {}) as { interpretation?: unknown; recordTypes?: unknown };
  const known = new Set(survey.map((r) => r.recordType));
  return {
    interpretation: String(input.interpretation ?? ''),
    // ONLY KEYS THAT EXIST. A model naming a plausible key it did not see is the vault-side twin of
    // inventing a predicate, and the read would simply return nothing while looking like it worked.
    recordTypes: (Array.isArray(input.recordTypes) ? input.recordTypes.map(String) : []).filter((k) => known.has(k)).slice(0, 25),
  };
}

/**
 * The whole capability: survey → choose → decode → hand back what was read.
 *
 * The ANSWER is composed by the ordinary composer from these observations, exactly as for every other
 * read. What this returns is evidence: the kinds present, which records were opened, and how the question
 * was read — so the diagnostics pane can show a person which of their records an answer came from.
 */
export function vaultQuestionInvoker(env: VaultQuestionEnv, deps: VaultQuestionDeps, subject?: string): ToolInvoker {
  return async (_toolId, args) => {
    const question = String((args as { question?: unknown }).question ?? '').trim();
    if (!question) return { refused: 'ask a question' };
    if (!subject) return { refused: 'this agent does not know whose records to read' };
    if (!deps.survey || !deps.readRecords) throw new Error('vault.records.query is not configured on this agent');

    const survey = await deps.survey(subject);
    if (!survey.length) {
      // Empty is an answer, and a specific one: nothing is stored, which is different from "I could not read it".
      return { answered: true, count: 0, kinds: [], interpretation: 'their vault holds no records', results: {} };
    }
    const kinds = surveyByKind(survey);

    const client = createFetchAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY! });
    const chosen = await chooseRecords(client, env.ORCHESTRATION_MODEL ?? 'claude-sonnet-4-6', question, survey);
    if (!chosen.recordTypes.length) {
      return {
        answered: false, interpretation: chosen.interpretation,
        reason: 'none of their records hold what this question needs',
        // The shape of the vault, so the answer can say what IS there instead of only what is not.
        kinds: kinds.map((k) => ({ kind: k.kind, count: k.count })),
      };
    }

    const records = await deps.readRecords(subject, chosen.recordTypes);
    return {
      answered: true,
      interpretation: chosen.interpretation,
      // Named for the diagnostics pane: WHICH of their records this answer came from (spec 357 §4 applies
      // here too — an answer whose sources nobody can inspect is a claim).
      query: `records opened: ${chosen.recordTypes.join(', ')}`,
      count: Object.keys(records).length,
      kinds: kinds.map((k) => ({ kind: k.kind, count: k.count })),
      results: records,
    };
  };
}

/** What kinds a question may be about — the binding's, never the model's. Exported for the vocabulary. */
export const VAULT_QUESTION_KINDS = askableRecordKinds;
export { recordTypesForClass };
