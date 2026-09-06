// ASKING THE PUBLIC KNOWLEDGE BASE A QUESTION IT WAS NEVER GIVEN A TOOL FOR — spec 357 W3.
//
// The Ask has three directory tools, and each encodes one question: search by words, fetch by key, list
// the kinds. "Which teams in Weld county declare an outreach capability, and who operates them" is none of
// those, so it came back as whatever the keyword search matched — a plausible list assembled by string
// comparison over a graph that could have answered precisely.
//
// THIS REVERSES A DELIBERATE DECISION, and says why. `ask-discovery.ts` records it: raw SPARQL was kept
// out because "the Ask has no playbook to describe a vocabulary with", and a planner writing SPARQL
// against a schema it half-knows invented `<https://vocab.account.tech/types/Person>`. That reasoning was
// right, and its stated cause is exactly what spec 357 W2 removed — the grounding corpus is projected
// FROM THE STORE, so every term the model is shown has data behind it and a count saying how much. The
// remaining half of the objection ("would have answered 'I don't know' with total confidence") is answered
// structurally rather than by hoping: the endpoint validates a PARSED query and refuses what it will not
// run, an empty result comes back as empty with the query attached, and nothing here ever softens either
// into prose. A wrong query is visible as a wrong query.
//
// WHAT THIS IS NOT. It is not authority. The knowledge base holds only public, on-chain-derivable facts
// (ADR-0040), so a generated query decides what is SHOWN and never what may be seen — nothing on this path
// may be cited as the reason anything was disclosed (spec 357 §4). It is not a write: the indexer remains
// the KB's only writer, and no part of the question, the asker or the run is ever pushed back.
//
// WHAT LEAVES. The generated QUERY reaches GraphDB, which may log it. The person's raw sentence must not:
// the model is told to express the question in the vocabulary, not to quote it, and search terms travel as
// terms exactly as `find_agents` already sends them.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { createFetchAnthropicClient, type AnthropicLike } from '@agenticprimitives/orchestration-anthropic';
import type { DiscoveryEnv } from './discovery-facets.js';

export const KB_QUESTION_TOOL: ToolSpec = {
  id: 'kb.question',
  description:
    'QUERIES THE PUBLIC DIRECTORY DIRECTLY to answer a question about it. USE THIS FOR ANY QUESTION ABOUT A '
    + 'KIND OR A GROUP — "what organizations are out there", "how many teams are there", "list the people", '
    + '"which agents have X", "who operates Y" — and for anything that counts, lists, filters or relates. '
    + 'find_agents cannot answer those: it matches search words against NAMES, so asking it for '
    + '"organizations" returns nothing even when the directory holds dozens. Use find_agents only when the '
    + 'ask NAMES a specific thing to look up. '
    + 'It reads PUBLIC data only — never membership rosters, vault records or private relationships. '
    + 'Args: question (the question, in plain words).',
  inputSchema: {
    type: 'object',
    properties: { question: { type: 'string', description: 'The question to answer from the public directory, in plain words.' } },
    required: ['question'],
  },
};

export interface KbQuestionEnv extends DiscoveryEnv {
  ORCHESTRATION_LLM?: string;
  ANTHROPIC_API_KEY?: string;
  ORCHESTRATION_MODEL?: string;
}

/** Offered ONLY when a model is configured. A tool that silently degrades to a keyword search is a tool
 *  that answers a different question than the one it advertises (ADR-0013). */
export function kbQuestionAvailable(env: KbQuestionEnv): boolean {
  return env.ORCHESTRATION_LLM === 'anthropic' && !!env.ANTHROPIC_API_KEY;
}

interface KbSchema {
  classes: Array<{ iri: string; label?: string; comment?: string; count: number }>;
  properties: Array<{ iri: string; label?: string; comment?: string; count: number }>;
  examples: Array<{ question: string; query: string }>;
  notes: string[];
}

async function discovery(env: DiscoveryEnv, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = env.DISCOVERY_MCP
    ? await env.DISCOVERY_MCP.fetch(`https://discovery-mcp${path}`, init)
    : env.DISCOVERY_MCP_BASE?.trim()
      ? await fetch(`${env.DISCOVERY_MCP_BASE.replace(/\/$/, '')}${path}`, init)
      : null;
  if (!res) throw new Error('the public agent directory is not reachable from this agent (no discovery binding)');
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  // A REFUSAL IS NOT A TRANSPORT FAILURE. The endpoint says why it will not run a query, and that sentence
  // is the one thing that lets a second attempt be better than the first.
  if (!body) throw new Error(`the public agent directory returned ${res.status}`);
  return body;
}

/** The grounding, as the model sees it: terms that HAVE DATA, with how much. */
function groundingPrompt(schema: KbSchema): string {
  const term = (t: { iri: string; label?: string; comment?: string; count: number }): string =>
    `  <${t.iri}>  (${t.count})${t.label ? ` — ${t.label}` : ''}${t.comment ? `: ${t.comment}` : ''}`;
  return [
    'You write SPARQL CONSTRUCT queries against a public agent directory (an RDF store).',
    '',
    'THE ONLY VOCABULARY THIS STORE HAS. The number is how many instances/uses exist — a term with data',
    'behind it. Any term not listed here does not exist here and will match nothing. Never invent an IRI,',
    'never use a vocabulary you know from elsewhere, and never guess a predicate because it "ought to"',
    'be called that.',
    '',
    'CLASSES:',
    ...schema.classes.map(term),
    '',
    'PROPERTIES:',
    ...schema.properties.map(term),
    '',
    'NOTES:',
    ...schema.notes.map((n) => `  - ${n}`),
    '',
    'WORKED EXAMPLES:',
    ...schema.examples.flatMap((e) => [`  Q: ${e.question}`, ...e.query.split('\n').map((l) => `     ${l}`), '']),
    'RULES:',
    '  - CONSTRUCT only. Not SELECT, not ASK, not DESCRIBE.',
    '  - Always state a LIMIT.',
    '  - No SERVICE, no GRAPH, no FROM — they are refused.',
    '  - Write the question in the vocabulary. Do NOT embed the user\'s sentence in the query.',
    '  - The CONSTRUCT template must include enough to answer: the subject, its name, and the properties asked about.',
    '  - If the question cannot be answered from the vocabulary above, say so in `interpretation` and',
    '    return an empty query. A query over terms that do not exist is worse than no answer.',
  ].join('\n');
}

const PROPOSE_TOOL = {
  name: 'propose_query',
  description: 'Propose the CONSTRUCT query that answers the question, and state how you read the question.',
  input_schema: {
    type: 'object',
    properties: {
      interpretation: { type: 'string', description: 'What you understood the question to be asking, in one sentence.' },
      query: { type: 'string', description: 'The SPARQL CONSTRUCT query. Empty string if the vocabulary cannot answer it.' },
    },
    required: ['interpretation', 'query'],
  },
} as const;

async function propose(
  client: AnthropicLike,
  model: string,
  system: string,
  question: string,
  priorRefusal?: { query: string; refusal: string },
): Promise<{ interpretation: string; query: string }> {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: question }];
  if (priorRefusal) {
    // THE ENDPOINT'S OWN WORDS go back, not a paraphrase. It knows why it refused; this loop does not.
    messages.push(
      { role: 'assistant', content: priorRefusal.query },
      { role: 'user', content: `That query was refused: ${priorRefusal.refusal}\nWrite one that the endpoint will run, answering the same question.` },
    );
  }
  const res = await client.messages.create({
    model, max_tokens: 1500, system, messages,
    tools: [PROPOSE_TOOL as never], tool_choice: { type: 'tool', name: 'propose_query' },
  });
  const block = res.content.find((b) => b.type === 'tool_use' && b.name === 'propose_query');
  const input = (block?.input ?? {}) as { interpretation?: unknown; query?: unknown };
  return { interpretation: String(input.interpretation ?? ''), query: String(input.query ?? '').trim() };
}

/**
 * Ask the knowledge base a question: ground → propose → validate at the endpoint → (one correction) → answer.
 *
 * Every outcome is REPORTED, never softened. A refusal after the correction comes back as a refusal with
 * both queries; an empty graph comes back as empty with the query that produced it. Neither falls through
 * to a keyword search — "nothing matches" and "I looked somewhere else instead" are different answers, and
 * a tool that quietly swaps one for the other cannot be trusted with either (ADR-0013).
 */
export function kbQuestionInvoker(env: KbQuestionEnv): ToolInvoker {
  return async (_toolId, args) => {
    const question = String((args as { question?: unknown }).question ?? '').trim();
    if (!question) return { refused: 'ask a question' };
    if (!kbQuestionAvailable(env)) throw new Error('kb.question needs a configured model on this agent');

    const schema = (await discovery(env, '/kb/schema')) as unknown as KbSchema & { ok?: boolean };
    const system = groundingPrompt(schema);
    const client = createFetchAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY! });
    const model = env.ORCHESTRATION_MODEL ?? 'claude-sonnet-4-6';

    const run = async (q: string): Promise<{ ok: boolean; jsonld?: unknown; query?: string; error?: string }> =>
      (await discovery(env, '/kb/construct', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }),
      })) as { ok: boolean; jsonld?: unknown; query?: string; error?: string };

    let proposal = await propose(client, model, system, question);
    if (!proposal.query) {
      // The model said the vocabulary cannot answer it. That is an answer, and a better one than a query
      // over terms that do not exist.
      return { answered: false, interpretation: proposal.interpretation, reason: 'the directory does not hold what this question needs' };
    }

    let result = await run(proposal.query);
    if (!result.ok) {
      const first = { query: proposal.query, refusal: String(result.error ?? 'refused') };
      proposal = await propose(client, model, system, question, first);
      result = proposal.query ? await run(proposal.query) : { ok: false, error: 'no second query proposed' };
      if (!result.ok) {
        return {
          answered: false, interpretation: proposal.interpretation,
          reason: `the directory refused the query: ${String(result.error ?? 'refused')}`,
          attempted: [first.query, proposal.query].filter(Boolean),
        };
      }
    }

    const graph = Array.isArray(result.jsonld) ? result.jsonld : [];
    return {
      answered: true,
      interpretation: proposal.interpretation,
      // The query travels with the answer (spec 357 §4). An answer whose query nobody can inspect is a claim.
      query: result.query,
      count: graph.length,
      results: graph.slice(0, 50),
    };
  };
}
