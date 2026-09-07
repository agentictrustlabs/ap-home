// WHAT THE PERSON HAS SELECTED — spec 361 I6 (context parity).
//
// A screen supplies meaning through selection long before a sentence is typed: a member row, a team, a
// treasury. This is the ONE place that meaning is held so the Ask can read it, as a REFERENCE the app
// checked (an address and its kind), never as words. Module-level, subscribable, cleared on navigation.
import { useSyncExternalStore } from 'react';

export interface AskSelection { entity: `0x${string}`; kind: string; label?: string }

let current: AskSelection | null = null;
const listeners = new Set<() => void>();

export function setAskSelection(sel: AskSelection | null): void {
  current = sel;
  for (const l of listeners) l();
}
export function getAskSelection(): AskSelection | null { return current; }
export function useAskSelection(): AskSelection | null {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, getAskSelection, () => null);
}
