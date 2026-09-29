// WHAT IS WAITING ON ME — the Ask's half of the bell (gap register B6a). The same two fast sources the Home's top-bar bell
// polls: her own agent's runs parked on HER (a signature, an answer, a confirmation), and the invitations that reached her
// inbox and are not yet accepted. A read of the asker's own records (self-acting, no mandate); each item says where it is
// done. Decisions she is a declared approver of live in each organization's work list — named in the note, not read here
// (one read per organization is the bell's slow lane, not an answer's).
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import type { Address } from 'viem';
import { isExpired, type SuspendedRunV1 } from './harness-runs.js';
import { invitationsOf, type InvitationsDeps } from './invitations-received.js';

export const WAITING_LIST_CAPABILITY = 'person.waiting.list' as const;

export const WAITING_LIST_TOOL: ToolSpec = {
  id: WAITING_LIST_CAPABILITY,
  answers: ["what's waiting on me", 'what is waiting on me', 'what do i need to do', 'anything for me to do', 'what needs me', 'my to do', 'what needs my signature', 'what needs my attention'],
  description:
    'WHAT IS WAITING ON THE PERSON — her agent\'s runs parked on her (a signature, an answer, a confirmation) and the '
    + 'invitations she has not accepted, each with where it is done. Use it for "what\'s waiting on me", "what do I need to do", '
    + '"anything that needs me". Her own records only. Args: none.',
  inputSchema: { type: 'object', properties: {} },
  establishes: 'lookup',
};

export interface WaitingItemV1 { kind: 'signature' | 'input' | 'confirmation' | 'invitation'; title: string; detail?: string; where: string; at?: number }

const KIND: Record<string, WaitingItemV1['kind']> = { signature: 'signature', authority: 'signature', data: 'input', confirmation: 'confirmation' };

/** Pure: the runs and invitations → what is hers to do, newest first. A run waiting on another agent (a commitment) waits on
 *  nobody here; an expired one is not waiting any more; one another person started is theirs. */
export function waitingItems(person: string, runs: readonly SuspendedRunV1[], invitations: ReadonlyArray<{ org: string; name: string | null; label?: string; invitedAt?: string; joined: boolean }>, now = Date.now()): WaitingItemV1[] {
  const me = person.toLowerCase();
  const out: WaitingItemV1[] = [];
  for (const r of runs) {
    const kind = r.awaiting ? KIND[r.awaiting.kind] : undefined;
    if (!kind || String(r.asker).toLowerCase() !== me || isExpired(r, now)) continue;
    out.push({ kind, title: r.message.slice(0, 140), detail: r.awaiting!.prompt.slice(0, 200), where: 'the Ask on your Home (Today lists it)', at: r.updatedAt });
  }
  for (const i of invitations) {
    if (i.joined) continue;
    const name = i.name ?? i.label ?? i.org;
    out.push({ kind: 'invitation', title: `Invitation to join ${name}`, where: `${name}'s Discussions page — or ask your agent to accept it`, ...(i.invitedAt ? { at: Date.parse(i.invitedAt) } : {}) });
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

export function waitingListInvoker(deps: InvitationsDeps & { listRuns?: (agent: Address) => Promise<SuspendedRunV1[]> }, person: string | undefined): ToolInvoker {
  return async () => {
    if (!person) return { refused: 'what is waiting on a person is read from their own records, and there is no signed-in person on this run' };
    const [runs, inv] = await Promise.all([
      deps.listRuns ? deps.listRuns(person.toLowerCase() as Address).catch(() => null) : Promise.resolve(null),
      invitationsOf(deps, person).catch(() => null),
    ]);
    const items = waitingItems(person, runs ?? [], inv?.invitations ?? []);
    const unread = [...(runs === null ? ['her parked runs'] : []), ...(inv === null ? ['her invitations'] : [])];
    return {
      count: items.length,
      items,
      interpretation: 'read her own agent\'s parked runs and her own inbox for invitations',
      note: (items.length
        ? 'These are waiting on her, newest first; say each in a line with where it is done. '
        : 'Nothing is waiting on her in her parked runs or her invitations. ')
        + 'Approvals she is named for in an organization\'s work are on that organization\'s Work page and are not part of this read.'
        + (unread.length ? ` Could not read ${unread.join(' or ')} just now — say so rather than "nothing".` : ''),
    };
  };
}
