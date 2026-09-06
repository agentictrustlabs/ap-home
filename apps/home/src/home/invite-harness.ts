// THE INVITE BUTTON'S GOVERNED CORE, through the harness — spec 361 I4, the screen side.
//
// Execution parity means the Members screen's Invite and the words "invite dave to this team" reach ONE
// implementation. The screen already knows its intent and parameters, so it submits a SUPPLIED PLAN —
// no model re-derives a click — through the same `/harness/ask` boundary the conversation uses, and the
// run crosses the same allowlist, verifier, risk ladder and approval port either way.
//
// ONE PROMPT. The reply's `alsoApprove` names the invitation-grant digest beside the mandate's;
// `mintApprovedMandate` approveHashes both in one org userOp, so the steward signs ONCE and the re-run
// finds the grant approved ON CHAIN. Then the surface's half: `recordInvitation` stores the signed wire
// in the org's vault — the same hook the flyout runs, because the recorder must not care which surface
// asked.
import type { Address } from '@agenticprimitives/types';
import { mintApprovedMandate, type AskReply } from './ask';
import { recordInvitation, invitationOf } from './ask-record';
import type { SignHash } from './resolution';
import { ensureCsrfToken, csrfHeaders } from '../csrf';

const j = async (r: Response) => (await r.json().catch(() => ({}))) as Record<string, unknown>;

async function askTurn(body: Record<string, unknown>): Promise<{ reply?: AskReply; runRef?: string; error?: string }> {
  await ensureCsrfToken();
  const res = await fetch('/a2a/harness/ask', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(body),
  });
  return (await j(res)) as { reply?: AskReply; runRef?: string; error?: string };
}

/**
 * Invite `invitee` into `org` — the one-prompt ceremony, end to end. Returns the same shape the panel's
 * old path produced so its messaging half continues unchanged.
 */
export async function inviteThroughHarness(input: {
  org: Address;
  invitee: Address;
  session: { token: string };
  signHash: SignHash;
}): Promise<{ ok: true; recorded: boolean } | { ok: false; error: string }> {
  const { org, invitee, session, signHash } = input;
  const plan = { steps: [{ toolId: 'organization.membership.invite', args: { org: org.toLowerCase(), invitee: invitee.toLowerCase() } }] };
  const message = `invite ${invitee.toLowerCase()} to ${org.toLowerCase()}`;

  // Turn 1 — deterministic entry, no mandate: authority_required carrying BOTH digests.
  const t1 = await askTurn({ session: session.token, addressee: org.toLowerCase(), message, plan });
  const rep = t1.reply;
  if (rep?.kind !== 'authority_required') {
    return { ok: false, error: t1.error ?? `expected an authority request, got ${rep?.kind ?? 'nothing'}` };
  }
  if (!rep.alsoApprove?.length) {
    // Without the bundle this path would cost two prompts — that is a regression to refuse loudly, not
    // silently absorb: the server must say what the act needs, in one reply, every time.
    return { ok: false, error: 'the agent did not name the invitation grant for one-prompt approval — not proceeding to a two-prompt ceremony' };
  }

  // THE prompt: one org userOp approves the mandate + the grant.
  const wire = await mintApprovedMandate(rep, signHash, session);

  // Turn 2 — the run finds the grant approved on chain and completes without asking again.
  const t2 = await askTurn({ session: session.token, addressee: org.toLowerCase(), runRef: rep.runRef, presented: wire });
  const rep2 = t2.reply;
  if (rep2?.kind === 'prompt') return { ok: false, error: `the run still prompted (${rep2.prompt?.kind}) — the one-prompt path did not hold` };
  if (rep2?.kind !== 'done' && rep2?.kind !== 'answer') {
    return { ok: false, error: t2.error ?? (rep2?.kind === 'refused' ? rep2.error : `unexpected reply ${rep2?.kind ?? 'nothing'}`) };
  }

  // The surface's half: the org's vault holds the invitation record.
  const inv = rep2.kind === 'done' ? invitationOf(rep2.result) : null;
  if (!inv) return { ok: true, recorded: false };
  const stored = await recordInvitation(inv, session.token);
  return { ok: true, recorded: stored.ok };
}
