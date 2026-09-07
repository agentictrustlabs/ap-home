// THE PROFILE FORM'S GOVERNED CORE, through the harness — spec 361 I4, fifth family.
//
// The form wrote the whole document straight to the vault; the Ask could not touch a profile at all.
// Both now enter at `/harness/ask`, and neither asks for a signature: the record is the person's own,
// written under their own session, so the capability is declared SELF-ACTING (`ToolSpec.selfAuthorized`)
// and the receipt records `self` as the basis rather than a mandate that never happened.
//
// WHAT THE FORM GAINS by converging: the write is a MERGE, so a partial save can no longer delete the
// fields it did not name; the email is checked before it is stored; and the act leaves a receipt like
// every other act, where before it left nothing at all.
import type { Address } from '@agenticprimitives/types';
import type { AskReply } from './ask';
import { ensureCsrfToken, csrfHeaders } from '../csrf';

const j = async (r: Response) => (await r.json().catch(() => ({}))) as Record<string, unknown>;

/** The scalar fields this capability holds. `location` stays with the form's own writer: it is a
 *  structured value with its own precision rules, and a flat merge would flatten what it means. */
export type ProfileFields = Partial<Record<
  'firstName' | 'lastName' | 'email' | 'phone' | 'organizationName' | 'organizationCountry' | 'city' | 'country',
  string
>>;

export async function profileThroughHarness(input: {
  person: Address;
  fields: ProfileFields;
  session: { token: string };
}): Promise<{ ok: true; changed: string[] } | { ok: false; error: string }> {
  const { person, fields, session } = input;
  const named = Object.entries(fields).filter(([, v]) => String(v ?? '').trim());
  if (!named.length) return { ok: true, changed: [] };
  const args = Object.fromEntries(named.map(([k, v]) => [k, String(v).trim()]));
  // A SCREEN KNOWS ITS OWN INTENT (spec 361): the form supplies its plan, so no model re-derives what a
  // person typed into labelled boxes. The sentence is what the same act sounds like out loud.
  const plan = { steps: [{ toolId: 'profile.contact.update', args }] };
  await ensureCsrfToken();
  const res = await fetch('/a2a/harness/ask', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({
      session: session.token, addressee: person.toLowerCase(),
      message: `update my profile (${Object.keys(args).join(', ')})`, plan,
    }),
  });
  const body = (await j(res)) as { reply?: AskReply; error?: string; detail?: string };
  const reply = body.reply;
  if (reply?.kind === 'done') {
    const r = reply.result as { changed?: string[] } | null;
    return { ok: true, changed: r?.changed ?? Object.keys(args) };
  }
  // The refusal a person can act on — "that is not an email address" — never a generic save failure.
  const why = reply?.kind === 'refused' ? reply.error : (body.detail ?? body.error ?? `unexpected reply ${reply?.kind ?? 'nothing'}`);
  return { ok: false, error: why };
}
