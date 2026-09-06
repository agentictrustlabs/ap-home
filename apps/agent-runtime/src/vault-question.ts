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
// WHOSE VAULT — spec 356 §2.2 (W3). Their own, plus every agent they STEWARD. Not every agent they can
// see, and emphatically not every agent they custody:
//
//   custody     — can this credential make that agent act. NEVER a source here (tbox core.ttl,
//                 `ap:CustodyMember`): whoever holds an organization's key is not thereby entitled to
//                 read what the organization knows, and the two sets routinely differ.
//   membership  — what am I part of. Informational; being a member authorizes nothing.
//   stewardship — a delegation the organization SIGNED, naming this person. That is the one that reads.
//
// The set is derived from the asker's own links and confirmed by `deriveStanding` (which checks the wire
// on chain where it can) — never from a subject the caller names as an argument and never from a
// client-supplied list (ADR-0041). A subject not in the set is REFUSED by name, and the refusal says what
// IS readable: "you may not read X" and "X has none of those" are different answers.
//
// AUTHORITY. Unchanged and not ours: every read rides the principal's own interactions grant, per-record
// scope enforced where it always was (spec 277, ADR-0041). Choosing a record authorizes nothing.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { createFetchAnthropicClient, type AnthropicLike } from '@agenticprimitives/orchestration-anthropic';
import { bindingForRecordType, askableRecordKinds, recordTypesForClass } from '@agenticprimitives/ontology';

export const VAULT_QUESTION_TOOL: ToolSpec = {
  id: 'vault.records.query',
  description:
    'ANSWERS A QUESTION ABOUT PRIVATE RECORDS the asker may read — their own, and those of any '
    + 'organization they STEWARD. Use this for "what am I working on", "what endeavors do I have", "what '
    + 'artifacts does the org hold", "what requests am I waiting on". '
    + 'It never reads the public directory (use find_agents / kb.question for anything public), and never '
    + 'a vault the asker has no stewardship delegation for. '
    + 'It READS ONLY: it never sends, pays, creates or changes anything. '
    + 'IF THE ASK NAMES WHOSE RECORDS TO LOOK IN, PASS `subject`. Without it this looks in the asker\'s own '
    + 'records and those of orgs they steward — which will answer a question about somebody else with the '
    + 'WRONG PERSON\'S data. If they may not read that subject you get a refusal, which is the right answer. '
    + 'Args: question (in plain words); subject (optional — whose records to look in, a name or address).',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question about the records, in plain words.' },
      subject: { type: 'string', description: 'Optional — the organization whose records to look in (name or address). Omit for everything the asker may read.' },
    },
    required: ['question'],
  },
};

/** One vault this asker may read, and WHY — the reason an answer has to be able to cite. */
export interface ReadableVault {
  subject: string;
  name?: string;
  why: 'self' | 'stewardship';
}

export interface VaultQuestionDeps {
  /** Every vault this asker may read. Derived (see the header); never a caller's list. */
  readableVaults?: (asker: string) => Promise<ReadableVault[]>;
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

/** How many vaults one question may survey. A question is answered from a few; surveying everything a
 *  steward can reach turns one ask into a fan-out across an estate. */
const MAX_SUBJECTS = 5;

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
  survey: Array<{ recordType: string; updatedAt?: string; owner: string; ownerLabel: string }>,
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
    'EVERY RECORD KEY, as owner :: key — choose keys in exactly that form:',
    ...survey.slice(0, 400).map((r) => `  ${r.ownerLabel} :: ${r.recordType}${r.updatedAt ? `  (updated ${r.updatedAt})` : ''}`),
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
  const known = new Set(survey.map((r) => `${r.ownerLabel} :: ${r.recordType}`));
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
export function vaultQuestionInvoker(
  env: VaultQuestionEnv,
  deps: VaultQuestionDeps,
  subject?: string,
  resolveName?: (name: string) => Promise<string | null>,
): ToolInvoker {
  return async (_toolId, args) => {
    const question = String((args as { question?: unknown }).question ?? '').trim();
    const named = String((args as { subject?: unknown }).subject ?? '').trim();
    if (!question) return { refused: 'ask a question' };
    if (!subject) return { refused: 'this agent does not know who is asking' };
    if (!deps.survey || !deps.readRecords) throw new Error('vault.records.query is not configured on this agent');

    // WHOSE VAULTS — derived, never taken from the ask. Absent the dep, this is their own and nothing else:
    // a missing derivation must narrow, never widen.
    const readable = deps.readableVaults
      ? await deps.readableVaults(subject)
      : [{ subject, why: 'self' as const }];
    if (!readable.length) return { refused: 'you have no records this agent may read' };

    // A NAMED SUBJECT IS CHECKED, NOT TRUSTED. Refused BY NAME with what is readable — because "you may
    // not read that" and "that has none of those" are different answers, and only one of them is about
    // the question they asked.
    let scope = readable;
    if (named) {
      // MATCHED AGAINST WHAT THEY MAY READ, in every form they might say it: the address, the registered
      // name, or what the thing is CALLED in their own links ("Missio Nexus"). The readable set is the
      // authority on both questions — what they may read, and what it is called to them — so a display
      // name must not fall through to a refusal just because it is not a registered name. It did: "what
      // artifacts does missio nexus hold" was refused for a vault its steward may plainly read.
      const norm = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, '');
      const wanted = /^0x[0-9a-fA-F]{40}$/.test(named)
        ? named.toLowerCase()
        : ((resolveName ? await resolveName(named.toLowerCase()).catch(() => null) : null) ?? '').toLowerCase();
      const hit = readable.find((v) => v.subject === wanted)
        ?? readable.find((v) => v.name && norm(v.name) === norm(named))
        // A prefix match last, and only when it is UNAMBIGUOUS: "missio" for one Missio Nexus is a name;
        // for two it is a question, and answering it by picking one reads the wrong vault.
        ?? (readable.filter((v) => v.name && norm(v.name).startsWith(norm(named))).length === 1
              ? readable.find((v) => v.name && norm(v.name).startsWith(norm(named)))
              : undefined);
      if (!hit) {
        return {
          answered: false,
          reason: `you have no stewardship of “${named}”, so this agent cannot read its records`,
          readable: readable.map((v) => ({ name: v.name ?? v.subject, why: v.why })),
        };
      }
      scope = [hit];
    }
    scope = scope.slice(0, MAX_SUBJECTS);

    // PHASE ONE — the inventory of each vault in scope. Metadata only; nothing decrypted.
    const label = (v: ReadableVault): string => v.name ?? v.subject;
    const surveys = await Promise.all(scope.map(async (v) => ({
      vault: v,
      rows: await deps.survey!(v.subject).catch(() => [] as Array<{ recordType: string; updatedAt?: string }>),
    })));
    const flat = surveys.flatMap(({ vault, rows }) =>
      rows.map((r) => ({ ...r, owner: vault.subject, ownerLabel: label(vault) })));
    if (!flat.length) {
      return {
        answered: true, count: 0, results: {},
        interpretation: scope.length === 1 ? `${label(scope[0]!)} holds no records` : 'none of those vaults hold records',
        looked: scope.map((v) => ({ subject: label(v), why: v.why })),
      };
    }

    // PHASE TWO — the model picks candidates from the INVENTORY. Nothing has been decrypted.
    const client = createFetchAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY! });
    const chosen = await chooseRecords(client, env.ORCHESTRATION_MODEL ?? 'claude-sonnet-4-6', question, flat);
    const kinds = surveyByKind(flat);
    if (!chosen.recordTypes.length) {
      return {
        answered: false, interpretation: chosen.interpretation,
        reason: 'none of those records hold what this question needs',
        kinds: kinds.map((k) => ({ kind: k.kind, count: k.count })),
        looked: scope.map((v) => ({ subject: label(v), why: v.why })),
      };
    }

    // PHASE THREE — decode, per owner, one batched call each. Grouped because the GRANT is per subject:
    // a batch cannot straddle two vaults, and pretending otherwise would be a cross-principal read.
    const byOwner = new Map<string, string[]>();
    for (const key of chosen.recordTypes) {
      const sep = key.indexOf(' :: ');
      if (sep < 0) continue;
      const row = flat.find((f) => f.ownerLabel === key.slice(0, sep) && f.recordType === key.slice(sep + 4));
      if (!row) continue;
      byOwner.set(row.owner, [...(byOwner.get(row.owner) ?? []), row.recordType]);
    }
    const results: Record<string, unknown> = {};
    const opened: string[] = [];
    for (const [owner, recordTypes] of byOwner) {
      const vault = scope.find((v) => v.subject === owner);
      const records = await deps.readRecords!(owner, recordTypes).catch(() => ({}));
      for (const [rt, data] of Object.entries(records)) {
        // Qualified in the RESULT too: a record means something different depending on whose it is, and an
        // answer that merges two vaults into one bag cannot say which.
        results[`${vault ? label(vault) : owner} :: ${rt}`] = data;
        opened.push(`${vault ? label(vault) : owner} :: ${rt}`);
      }
    }

    return {
      answered: true,
      // WHOSE RECORDS THESE ARE, first and in words. Everything below is about these agents and nobody
      // else; an answer that names a different person is contradicting its own evidence.
      recordsOf: scope.map((v) => label(v)),
      interpretation: chosen.interpretation,
      // WHOSE RECORDS, AND WHY THEY WERE READABLE. The citation an answer has to be able to make: "as a
      // steward of Missio Nexus" is the difference between an answer and an assertion (spec 356 §2.2).
      looked: scope.map((v) => ({ subject: label(v), why: v.why })),
      query: `records opened: ${opened.join(', ')}`,
      count: opened.length,
      kinds: kinds.map((k) => ({ kind: k.kind, count: k.count })),
      results,
    };
  };
}

/** What kinds a question may be about — the binding's, never the model's. Exported for the vocabulary. */
export const VAULT_QUESTION_KINDS = askableRecordKinds;
export { recordTypesForClass };
