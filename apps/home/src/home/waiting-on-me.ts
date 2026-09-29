// WHAT IS WAITING ON ME — the bell (gap register B6a, spec 398 §5.5). ONE read of everything that is the person's to do
// next, on every page: a run parked on her signature, a decision she is a declared approver of, a run that stopped to ask
// her something, and an invitation she has not accepted. Pure: it takes what the clients return and says what is waiting;
// it fetches nothing and authorizes nothing. The decisions and inputs are Today's own (`assembleToday`) — the bell is not
// a second attention model; invitations are what Today never counted (ezra.me was invited and had no signal).
import { assembleToday, type TodayInputs } from './today';

export type WaitingKind = 'signature' | 'decision' | 'input' | 'invitation';

export interface WaitingItem {
  id: string;
  kind: WaitingKind;
  title: string;
  detail?: string;
  /** Where it is done. */
  href: string;
  at?: number;
}

/** An invitation as `person.invitations.list` returns it (her own inbox + her relationships). */
export interface ReceivedInvitation { org: string; name: string | null; label?: string; invitedAt?: string; joined: boolean }

export interface WaitingInputs {
  now: number;
  parked: TodayInputs['parked'];
  bundles: TodayInputs['bundles'];
  invitations: ReadonlyArray<ReceivedInvitation>;
}

const WHERE_TODAY = '/';

export function assembleWaiting(input: WaitingInputs): WaitingItem[] {
  const today = assembleToday({ now: input.now, parked: input.parked, bundles: input.bundles, artifacts: [], triggers: [], vocabulary: [] });
  const out: WaitingItem[] = [];
  for (const d of today.decisions) {
    // A decision with a run is a parked act — her signature; one without is an approval she was named for (Work).
    out.push({ id: `d:${d.id}`, kind: d.runRef ? 'signature' : 'decision', title: d.title, ...(d.detail ? { detail: d.detail } : {}), href: d.href ?? WHERE_TODAY, ...(d.at ? { at: d.at } : {}) });
  }
  for (const a of today.active) {
    if (a.state?.state !== 'awaiting-input') continue;
    out.push({ id: `i:${a.id}`, kind: 'input', title: a.title, detail: a.detail ?? 'your agent is waiting for an answer', href: a.href ?? WHERE_TODAY, ...(a.at ? { at: a.at } : {}) });
  }
  for (const inv of input.invitations) {
    if (inv.joined) continue;
    const name = inv.name ?? inv.label ?? `${inv.org.slice(0, 10)}…`;
    out.push({
      id: `inv:${inv.org}`, kind: 'invitation', title: `Invitation to join ${name}`, detail: 'accept it there, or ask your agent to',
      href: `/org/${inv.org.toLowerCase()}/discussions`, ...(inv.invitedAt ? { at: Date.parse(inv.invitedAt) } : {}),
    });
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

export const WAITING_LABEL: Record<WaitingKind, string> = { signature: 'Needs your signature', decision: 'Needs your decision', input: 'Needs your answer', invitation: 'Invitation' };
