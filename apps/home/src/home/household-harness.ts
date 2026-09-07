// THE HOUSEHOLD PANEL'S GOVERNED CORE — spec 363 W4 / spec 361 I4.
//
// Both surfaces enter at `/harness/ask`: the panel supplies its plan (it knows its own intent), the
// sentence is interpreted, and from there it is ONE capability with one record and one receipt trail.
// Neither asks for a signature — the record is the person's own, so the capability is SELF-ACTING
// (spec 350 §3.2a) and the receipt records `self` rather than a mandate that never happened.
import type { Address } from '@agenticprimitives/types';
import type { AskReply } from './ask';
import { ensureCsrfToken, csrfHeaders } from '../csrf';

export interface HouseholdMemberRow { agent: string; label?: string; name?: string; role?: string; relation?: string }

const j = async (r: Response) => (await r.json().catch(() => ({}))) as { reply?: AskReply; error?: string; detail?: string };

async function ask(body: Record<string, unknown>) {
  await ensureCsrfToken();
  return j(await fetch('/a2a/harness/ask', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(body),
  }));
}

/** The roster, read through the same informational capability the conversation uses. */
export async function readHouseholdThroughHarness(input: { person: Address; session: { token: string } }):
Promise<{ ok: true; members: HouseholdMemberRow[] } | { ok: false; error: string }> {
  const out = await ask({
    session: input.session.token, addressee: input.person.toLowerCase(),
    message: 'who is in my household',
    plan: { steps: [{ toolId: 'household.roster', args: {} }] },
  });
  const reply = out.reply;
  // An informational plan comes back as an `answer`; the members ride the evidence, not the prose — the
  // panel renders rows, and a sentence composed for a person is not a data source.
  if (reply?.kind === 'answer') {
    const rows = (reply as { results?: Array<{ toolId: string; result: unknown }> }).results ?? [];
    const found = rows.find((x) => x.toolId === 'household.roster')?.result as { members?: HouseholdMemberRow[] } | undefined;
    return { ok: true, members: found?.members ?? [] };
  }
  return { ok: false, error: out.detail ?? out.error ?? (reply?.kind === 'refused' ? reply.error : 'the household could not be read') };
}

/** Record or remove ONE member — merge, never a whole-document write. */
export async function householdThroughHarness(input: {
  person: Address; session: { token: string };
  member: string; kin?: string; role?: string; label?: string; remove?: true;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const args: Record<string, unknown> = { member: input.member };
  if (input.kin) args.kin = input.kin;
  if (input.role) args.role = input.role;
  if (input.label) args.label = input.label;
  if (input.remove) args.remove = true;
  const out = await ask({
    session: input.session.token, addressee: input.person.toLowerCase(),
    message: input.remove ? `remove ${input.member} from my household` : `record ${input.member} in my household`,
    plan: { steps: [{ toolId: 'household.member.record', args }] },
  });
  const reply = out.reply;
  if (reply?.kind === 'done') return { ok: true };
  return { ok: false, error: out.detail ?? out.error ?? (reply?.kind === 'refused' ? reply.error : `unexpected reply ${reply?.kind ?? 'nothing'}`) };
}
