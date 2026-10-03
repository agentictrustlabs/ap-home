// FIELD RAILS — THE FIELD WRITE AS A CAPABILITY (pokernight/docs/FIELD-RAILS.md §3/§5/§6; companion game
// FIELD-OPERATIONS.md). `field.records-save` is the CHARACTER's own act: a day of a Field Operations season
// (a visit, a study, a gathering, a baptism, support given) becomes a well-formed activity/observation and is
// SUBMITTED to the Field Circles executor (~/engage/apps/field-a2a, `field.records-save`), which validates it
// (`validateFieldRecord`) and lands it in the team organization's own Library with `recordedBy` = this persona.
// It is the SAME door field.faithnet.io's Capture.tsx `sendFieldIntent` drives — never a hand-built JSON write
// into `/connect/library` (that was "today's dump", retired as the live path).
//
// SELF-ACTING (`selfAuthorized`, like library.file.save): the actor, the author (`recordedBy`) and the subject
// are one principal — the character — so the SESSION is the authority and no external mandate is redeemed. The
// record is an occurrence, never an outcome or a phase; readiness and the derived phase stay the game engine's.
//
// NOT an external-agent observation: this is a FIRST-PARTY call to the operator's Field Circles executor (its URL
// is operator config, `FIELD_A2A_URL`), so it is dispatched by this bespoke invoker and is NOT subject to
// `externalExecutorsReadOnly` (which gates the generic `external.agent.ask` / `engagement.agent.invoke` lanes).
//
// DEMO SHORTCUT, said out loud (FIELD-RAILS §12): the character's Field Circles session is minted by the demo
// Home's `demo-signin` (`client_id: field-app`, `as: <persona>`) rather than a device approval. On a non-demo
// estate the persona's own credential presents the session; `fieldSession` is the one seam that changes there.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import type { Address } from '@agenticprimitives/types';
import { ADAPTER } from './adapter-declarations.js';

export const FIELD_RECORDS_SAVE = 'field.records-save' as const;
/** The acts this file owns — a mandate is NOT required (self-acting), but the loop treats them as writes. */
export const FIELD_ACTS: ReadonlySet<string> = new Set([FIELD_RECORDS_SAVE]);

/** The record kinds a capture produces. An activity is an occurrence; an observation is instrument-derived. Never a phase. */
const RECORD_KINDS = ['activity', 'observation'] as const;

export const FIELD_TOOLS: ToolSpec[] = [
  {
    id: FIELD_RECORDS_SAVE,
    verbs: ['record the visit', 'log what happened', 'capture the activity', 'write the observation', 'record the field work', 'note the gathering', 'record the baptism', 'log the support given'],
    description:
      'RECORDS one field activity or observation in Field Circles AS THIS CHARACTER (Field Rails §3/§5): the day\'s '
      + 'occurrence — a visit, share, study, gather, baptize, train, report or support — is made into a well-formed '
      + 'activity/observation and SUBMITTED to the Field Circles executor, which validates it and lands it in the '
      + 'team organization\'s own Library with recordedBy = this persona. An occurrence, never an outcome or a phase '
      + '(readiness and the derived phase are the game engine\'s, never written here). Args: team (the team '
      + 'organization address the work is recorded under), goal (what happened, in the worker\'s own words), kind '
      + '(activity | observation; default activity), community (optional — the people community it concerns).',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'The team organization (address) the activity is recorded under' },
        goal: { type: 'string', description: 'What happened, in the worker\'s own words' },
        kind: { type: 'string', enum: [...RECORD_KINDS], description: 'activity (an occurrence) or observation (instrument-derived)' },
        community: { type: 'string', description: 'The people community the work concerns (optional)' },
      },
      required: ['team', 'goal'],
    },
    // The record is the team organization's; `holder` authority = the character's own session (self-acting).
    capability: { id: FIELD_RECORDS_SAVE, action: 'record', resourceArg: 'team', authorityArg: 'holder' },
    risk: 'low',
    adapter: ADAPTER.external,
    selfAuthorized: true,
    establishes: 'submission',
  },
];

/** What a Field Circles save returns — the subset the engine's apply gate needs as a RECEIPT (FIELD-RAILS §5). */
export interface FieldSaveReceipt {
  /** Where Field Circles stored it (a vault/library pointer), its record id, and the org it landed under. */
  storedIn?: string;
  recordId?: string;
  org?: string;
  tier?: string;
}

export interface FieldToolDeps {
  /** The Field Circles executor's base URL (operator config). Its `/a2a` is the `message/send` door. Absent ⇒ refused. */
  fieldA2aUrl?: string;
  /**
   * THE ONE SEAM: a field-app session (id_token) for THIS character, the way the browser holds one. In the demo
   * estate this is `demo-signin { client_id: 'field-app', handle: <custodian>, as: <persona> }`; on a real estate
   * the persona's own credential mints it. Returns null when no session can be obtained (⇒ the act is refused and
   * the season counts a miss, never a silent engine apply).
   */
  fieldSession: (persona: Address) => Promise<string | null>;
  fetch?: typeof fetch;
}

/** The character this run acts as — the run's principal. Field writes are ALWAYS the character (FIELD-RAILS §6). */
export function fieldInvoker(deps: FieldToolDeps, principal: Address | undefined): ToolInvoker {
  const f = deps.fetch ?? fetch;
  return async (toolId, args) => {
    if (toolId !== FIELD_RECORDS_SAVE) return { refused: `field-tools does not own ${toolId}` };
    if (!principal) return { refused: 'field.records-save acts as the character and this run has no principal' };
    const base = (deps.fieldA2aUrl ?? '').replace(/\/$/, '');
    if (!base) return { refused: 'no Field Circles executor is configured on this deployment (FIELD_A2A_URL)' };

    const team = String(args.team ?? '').trim();
    const goal = String(args.goal ?? '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(team)) return { refused: 'which team? — name the team organization (address) this is recorded under' };
    if (!goal) return { refused: 'what happened? — the activity needs the worker\'s own words (goal)' };
    const kind = RECORD_KINDS.includes(args.kind as typeof RECORD_KINDS[number]) ? (args.kind as string) : 'activity';
    const community = typeof args.community === 'string' && args.community.trim() ? args.community.trim() : undefined;

    const idToken = await deps.fieldSession(principal).catch(() => null);
    if (!idToken) return { refused: 'could not obtain a Field Circles session for this character' };

    // The SAME request field.faithnet.io's `sendFieldIntent` makes (apps/field-web/src/intents.ts): JSON-RPC
    // `message/send`, the goal as the text part, `metadata.skill` naming the intent and the record's context.
    const res = await f(`${base}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{ kind: 'text', text: goal }],
            metadata: { skill: FIELD_RECORDS_SAVE, kind, workspace: team, ...(community ? { community } : {}) },
          },
        },
      }),
    }).catch((e: unknown) => ({ ok: false, status: 0, json: async () => ({ error: { message: String(e) } }) } as unknown as Response));

    const body = (await res.json().catch(() => null)) as { result?: Record<string, unknown>; error?: { message?: string; data?: { error?: string } } } | null;
    if (!res.ok || body?.error) {
      const reason = body?.error?.data?.error ?? body?.error?.message ?? `Field Circles refused field.records-save (${res.status})`;
      return { refused: reason };
    }
    const result = body?.result ?? {};
    const receipt: FieldSaveReceipt = {
      storedIn: typeof result.storedIn === 'string' ? result.storedIn : undefined,
      recordId: typeof result.recordId === 'string' ? result.recordId : (typeof result.id === 'string' ? result.id : undefined),
      org: team,
      tier: typeof result.tier === 'string' ? result.tier : undefined,
    };
    // The harness records the APPLIED tool + this receipt in `run.provenance`; the season's apply gate reads
    // both before it lets the engine apply the move (FIELD-RAILS §5).
    return { answer: `Recorded the ${kind} with Field Circles.`, receipt, record: result };
  };
}
