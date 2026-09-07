// SENDING THE REQUEST — spec 338 §7, on the messaging rail.
//
// The request lands in the owner's vault the same way any message does: under their own authority, into
// records only they can read (ADR-0025). Nothing about it is special except its typed body, which is what
// lets their Home show it as a decision rather than as prose to be interpreted.
//
// It grants nothing on arrival. A pending request is a question; the answer is the owner's, made in their
// own Home, and until they make it Nathan knows exactly what he knew before.
import { InputRequired, type ToolInvoker } from '@agenticprimitives/orchestration';
import { readValue, agentKindChoices } from '@agenticprimitives/ontology';
import type { Address } from 'viem';
import { RESOLUTION_REQUESTS_RECORD, RESOLUTION_SENT_RECORD, type ResolutionInvitationRequestV1, type SentResolutionRequestV1 } from './resolution-invitation.js';

/**
 * WHERE TO GO TO DO SOMETHING ABOUT IT. A message that describes an action without saying where to take
 * it makes the reader hunt for the page, and most will not — the request then sits unanswered and looks
 * to the asker like it was ignored. The Home's own origin, so the link works wherever this is deployed.
 */
export function actionLink(homeOrigins: string | undefined, path: string): string {
  // PREFER AN ORIGIN A PERSON CAN ACTUALLY OPEN. `ALLOWED_ORIGINS` is a CSRF allowlist, not a list of
  // places to send someone, and it carries the local dev origins first — so the obvious "take the first
  // one" put `http://localhost:5175/treasuries` in a message sent to somebody else's machine.
  const all = (homeOrigins ?? '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  const base = all.find((o) => o.startsWith('https://') && !/localhost|127\.0\.0\.1/.test(o)) ?? '';
  return base ? `${base}${path}` : '';
}

export interface ResolutionRequestDeps {
  /** The Home this agent's people use, for links a person can actually follow. */
  homeOrigin?: string;
  sendDirectMessage?: (input: {
    sender: Address; recipient: Address; bodyText: string; session: string;
    /** Spec 364 — typed pointers the recipient's surface renders as the decision itself. Display and
     *  routing metadata, never authority (spec 309 §4.2). */
    contextRefs?: Array<{ kind: string; id: string; label?: string }>;
  }) => Promise<{ ok: true; messageId?: string } | { ok: false; error: string }>;
  /** Appends the typed request to the OWNER's own request record, so their Home can act on it. */
  appendSubjectRecord?: (subject: string, recordType: string, entry: unknown) => Promise<{ ok: boolean; error?: string }>;
  resolveName?: (name: string) => Promise<string | null>;
}

export function resolutionRequestInvoker(deps: ResolutionRequestDeps, person?: Address, session?: string): ToolInvoker {
  return async (_toolId, args, ctx) => {
    /** What the person actually typed — the figure lives here, not in a planner's rewrite of it. */
    const goal = String((ctx?.intent as { goal?: unknown } | undefined)?.goal ?? '');
    if (!person) throw new Error('this agent does not know who is asking');
    const raw = String((args as { owner?: unknown }).owner ?? '').trim();
    if (!raw) throw new Error('resolution.invitation.request needs the person to ask');
    const owner = (/^0x[0-9a-fA-F]{40}$/.test(raw)
      ? raw
      : ((deps.resolveName ? await deps.resolveName(raw.toLowerCase()) : null) ?? '')).toLowerCase() as Address;
    if (!owner) throw new Error(`"${raw}" did not resolve to an agent to ask`);
    // WHICH KIND OF AGENT, and NO DEFAULT. This read `?? 'treasury'`, so an ask that never mentioned
    // money produced a request for a treasury: Alice invited Bob to a team and Bob was sent *"I'd like a
    // way to reach your treasury — to invite bob to join this team"*, which is two unrelated sentences
    // stapled together and nothing he could act on. A default nobody modelled is exactly the improvised
    // decision spec 363 exists to remove; the honest move is to ask, in the person's own terms.
    const purpose = String((args as { purpose?: unknown }).purpose ?? '').trim() || 'to send you money';
    // THE KIND, READ BY ITS TYPE (spec 363 W2). The allowlist that used to live here is now the
    // `AgentKind` reader, whose vocabulary is the derived agent types themselves (ADR-0061) — so this
    // file cannot drift from what the naming service actually mints.
    const read = readValue('AgentKind', (args as { wants?: unknown }).wants);
    const wants = read.ok ? read.value : '';
    if (!wants) {
      throw new InputRequired({
        kind: 'data', stepRef: 'pending', toolId: _toolId,
        prompt: `What of ${raw}'s do you need a way to reach?`,
        fields: [{
          name: 'wants', label: 'what you need', type: 'choice', required: true,
          // The kinds come from the ONTOLOGY's own list, so a new derived type appears here the day it
          // is declared rather than the day somebody remembers this array.
          choices: agentKindChoices().map((c) => ({ value: c.value, label: `their ${c.label}` })),
          allowOther: true,
        }],
      });
    }

    // The figure, from the argument when the planner passed it and from the words when it did not.
    // Reading the sentence is a heuristic and I have been avoiding those — this one is narrow enough to
    // defend: it extracts a number the PERSON typed, into a field whose only use is prefilling a later
    // ask, and which never reaches a caveat or a gate. Losing it costs them the one-press finish, which
    // is the whole point of recording it.
    const fromArg = String((args as { usdc?: unknown }).usdc ?? '').trim();
    // THE PERSON'S OWN WORDS FIRST, then the planner's paraphrase. Scanning only the `purpose` lost the
    // figure whenever the planner rewrote "I want to send 1.2 usdc" as "to send you money" — which it
    // usually does, because a purpose is meant to read as a sentence. The goal is what they typed.
    const said = `${goal} ${String((args as { purpose?: unknown }).purpose ?? '')}`;
    const spoken = /(\d+(?:\.\d+)?)\s*usdc/i.exec(said)?.[1];
    const amount = /^\d+(\.\d+)?$/.test(fromArg) ? fromArg : (spoken ?? '');
    const at = new Date().toISOString();
    const request: ResolutionInvitationRequestV1 = {
      v: 1, kind: 'resolution.invitation.request',
      requester: person, owner, wants, purpose, ...(amount ? { amount } : {}), requestedAt: at,
    };

    // The DECISION record first: a message they might miss is not a request they can act on, and the Home
    // reads this record to show the Approve button.
    const stored = await deps.appendSubjectRecord?.(owner, RESOLUTION_REQUESTS_RECORD, request);
    if (stored && !stored.ok) {
      // `record_scope_denied` is not a failure of the request — it means their storage does not yet cover
      // this kind of record, which only they can change. Say that, rather than a code.
      const why = /record_scope_denied|scope/i.test(stored.error ?? '')
        ? 'their Home has not enabled this kind of request yet — they need to open it once, then ask again'
        : stored.error ?? 'unknown';
      throw new Error(`the request could not be recorded for them: ${why}`);
    }

    // THE REQUESTER'S OWN COPY. Without it, a grant arriving days later is an address with no story:
    // their Home cannot say "this is the thing you were trying to pay, and here is the amount". Written
    // best-effort — the request itself has already landed, and losing the note costs a button, not the ask.
    await deps.appendSubjectRecord?.(person, RESOLUTION_SENT_RECORD, {
      v: 1, kind: 'resolution.invitation.sent', owner, wants, ...(amount ? { amount } : {}), requestedAt: at,
    } satisfies SentResolutionRequestV1).catch(() => undefined);

    // Then the human-readable half, so it appears where they read things.
    // The note says what to DO, including the case where they have none of that kind — which is the
    // common one for a first payment, and the one where "approve it in your Home" reads as nonsense.
    const where = actionLink(deps.homeOrigin, wants === 'treasury' ? '/treasuries' : '/agents');
    // A link that cannot be opened is worse than none: it reads as an instruction and goes nowhere.
    // THE DECISION TRAVELS WITH THE MESSAGE (spec 364). The words used to end in a link to another page:
    // the person read a request in one place and had to go and find it in another, which is how one
    // intent became two flows and both were abandoned. The `contextRef` is a POINTER — display and
    // routing metadata, never authority (spec 309 §4.2) — and the Home renders it as the decision
    // itself, taken where it was read. Approving still runs every gate the page ran.
    const note = `I'd like a way to reach your ${wants} — ${purpose}. If you have a ${wants}, approving lets me send to it; if you do not, you can create one first. Either way it gives me no control over it.`;
    const sent = session ? await deps.sendDirectMessage?.({
      sender: person, recipient: owner, bodyText: note, session,
      // WHO is asking and FOR WHAT — enough for the recipient's surface to offer the decision inline.
      // The id is the pair the owner's own request record is keyed by, so the chip acts on a request
      // THEY hold rather than on anything the message asserts.
      contextRefs: [{ kind: 'resolution-request', id: `${person.toLowerCase()}/${wants}`, label: `a way to reach your ${wants}` }],
    }) : undefined;

    return {
      requested: true, owner, wants, purpose,
      recorded: !!stored?.ok,
      messaged: sent?.ok === true,
      ...(sent && sent.ok === false ? { messageError: sent.error } : {}),
    };
  };
}
