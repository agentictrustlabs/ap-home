// "PAY ME HERE", through the harness — spec 361 I4, third family.
//
// The legacy control called `addRole` on the relationship record straight from the browser: one
// signature, and an act the Ask could not perform. This path costs the SAME one signature (the mandate)
// and converges on the harness's `treasury.primary.declare` invoker, so the button and the words
// "payments to me should go to alice2.treasury" are one implementation with one receipt trail.
//
// What the button GAINS by converging: naming a new primary CLEARS the previous one in the same act.
// Two treasuries both marked is not a stronger preference — a payer reads it as ambiguity and asks
// anyway, which is the question this feature exists to remove.
import type { Address } from '@agenticprimitives/types';
import { mintMandate, type AskReply } from './ask';
import type { SignHash } from './resolution';
import { ensureCsrfToken, csrfHeaders } from '../csrf';

const j = async (r: Response) => (await r.json().catch(() => ({}))) as Record<string, unknown>;

async function askTurn(body: Record<string, unknown>): Promise<{ reply?: AskReply; error?: string }> {
  await ensureCsrfToken();
  const res = await fetch('/a2a/harness/ask', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(body),
  });
  return (await j(res)) as { reply?: AskReply; error?: string };
}

export async function primaryPayeeThroughHarness(input: {
  treasury: Address;
  /** The owner — whose preference this is. The mandate's delegator, and the only party who may set it. */
  person: Address;
  on: boolean;
  session: { token: string };
  signHash: SignHash;
}): Promise<{ ok: true; txHash?: string; note?: string } | { ok: false; error: string }> {
  const { treasury, person, on, session, signHash } = input;
  const t = treasury.toLowerCase();
  // A SCREEN KNOWS ITS OWN INTENT (spec 361): the plan is supplied, so no model re-derives what a click
  // already said. The sentence is what the same act sounds like when a person says it, and it is what
  // the mandate binds to — the two surfaces reach the identical boundary.
  const plan = { steps: [{ toolId: 'treasury.primary.declare', args: { treasury: t, holder: person.toLowerCase(), on } }] };
  const message = on ? `payments to me should go to ${t}` : `stop receiving payments at ${t}`;

  const t1 = await askTurn({ session: session.token, addressee: person.toLowerCase(), message, plan });
  const rep = t1.reply;
  // ALREADY TRUE IS NOT A FAILURE. The invoker reports `alreadySet` without a transaction rather than
  // sending one that changes nothing, and a screen that treated that as an error would ask the person to
  // sign again for a state they already have.
  if (rep?.kind === 'done') {
    const r = rep.result as { alreadySet?: boolean; declared?: boolean; note?: string } | null;
    return { ok: true, ...(r?.note ? { note: r.note } : {}) };
  }
  if (rep?.kind !== 'authority_required') {
    return { ok: false, error: t1.error ?? (rep?.kind === 'refused' ? rep.error : `expected an authority request, got ${rep?.kind ?? 'nothing'}`) };
  }
  const wire = await mintMandate(rep, signHash);
  const t2 = await askTurn({ session: session.token, addressee: person.toLowerCase(), runRef: rep.runRef, presented: wire });
  const rep2 = t2.reply;
  if (rep2?.kind !== 'done') {
    return { ok: false, error: t2.error ?? (rep2?.kind === 'refused' ? rep2.error : `unexpected reply ${rep2?.kind ?? 'nothing'}`) };
  }
  const r = rep2.result as { txHash?: string; note?: string } | null;
  return { ok: true, ...(r?.txHash ? { txHash: r.txHash } : {}), ...(r?.note ? { note: r.note } : {}) };
}
