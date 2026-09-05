// SENDING THE REQUEST — spec 338 §7, on the messaging rail.
//
// The request lands in the owner's vault the same way any message does: under their own authority, into
// records only they can read (ADR-0025). Nothing about it is special except its typed body, which is what
// lets their Home show it as a decision rather than as prose to be interpreted.
//
// It grants nothing on arrival. A pending request is a question; the answer is the owner's, made in their
// own Home, and until they make it Nathan knows exactly what he knew before.
import type { ToolInvoker } from '@agenticprimitives/orchestration';
import type { Address } from 'viem';
import { RESOLUTION_REQUESTS_RECORD, type ResolutionInvitationRequestV1 } from './resolution-invitation.js';

export interface ResolutionRequestDeps {
  sendDirectMessage?: (input: { sender: Address; recipient: Address; bodyText: string; session: string }) =>
    Promise<{ ok: true; messageId?: string } | { ok: false; error: string }>;
  /** Appends the typed request to the OWNER's own request record, so their Home can act on it. */
  appendSubjectRecord?: (subject: string, recordType: string, entry: unknown) => Promise<{ ok: boolean; error?: string }>;
  resolveName?: (name: string) => Promise<string | null>;
}

export function resolutionRequestInvoker(deps: ResolutionRequestDeps, person?: Address, session?: string): ToolInvoker {
  return async (_toolId, args) => {
    if (!person) throw new Error('this agent does not know who is asking');
    const raw = String((args as { owner?: unknown }).owner ?? '').trim();
    if (!raw) throw new Error('resolution.invitation.request needs the person to ask');
    const owner = (/^0x[0-9a-fA-F]{40}$/.test(raw)
      ? raw
      : ((deps.resolveName ? await deps.resolveName(raw.toLowerCase()) : null) ?? '')).toLowerCase() as Address;
    if (!owner) throw new Error(`"${raw}" did not resolve to an agent to ask`);
    const wants = String((args as { wants?: unknown }).wants ?? 'treasury').trim().toLowerCase();
    const purpose = String((args as { purpose?: unknown }).purpose ?? '').trim() || 'to send you money';

    const request: ResolutionInvitationRequestV1 = {
      v: 1, kind: 'resolution.invitation.request',
      requester: person, owner, wants, purpose, requestedAt: new Date().toISOString(),
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

    // Then the human-readable half, so it appears where they read things.
    // The note says what to DO, including the case where they have none of that kind — which is the
    // common one for a first payment, and the one where "approve it in your Home" reads as nonsense.
    const note = `I'd like a way to reach your ${wants} — ${purpose}. Open your Home (Requests): if you have a ${wants}, approving there lets me send to it; if you do not, you can create one first. Either way it gives me no control over it.`;
    const sent = session ? await deps.sendDirectMessage?.({ sender: person, recipient: owner, bodyText: note, session }) : undefined;

    return {
      requested: true, owner, wants, purpose,
      recorded: !!stored?.ok,
      messaged: sent?.ok === true,
      ...(sent && sent.ok === false ? { messageError: sent.error } : {}),
    };
  };
}
