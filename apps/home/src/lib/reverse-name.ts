'use client';
// Reverse-resolve an agent address → its primary name, via /connect/reverse-name
// (a single on-chain reverseResolveString read server-side). Cached + de-duped per
// address so a page full of AddressChips makes at most one request each.
//
// USE THIS ANYWHERE A NAME IS A KEY. An agent's row in the managed-agent list carries a DISPLAY LABEL —
// for a workspace that is a human phrase ("Northern Colorado Field"), not something the naming service
// can resolve. Feeding a label to `namehash` produces a node nobody registered, every record reads back
// empty, and the screen reports a registered agent as unregistered (seen 2026-08-31 on Naming, and the
// same shape in the treasury host bindings and the card's endpoint write). The address is the identity
// (ADR-0010); the registered name is what the chain says resolves to it.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

export async function reverseAgentName(address: Address): Promise<string | null> {
  const key = address.toLowerCase();
  if (cache.has(key)) return cache.get(key) ?? null;
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      const r = await fetch(`/connect/reverse-name?address=${key}`);
      const b = (await r.json().catch(() => ({}))) as { name?: string | null };
      const name = b.name ?? null;
      cache.set(key, name);
      return name;
    } catch {
      cache.set(key, null);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** The REGISTERED name for an address — `null` while loading and when nothing resolves to it.
 *  `loaded` separates "no name" from "not yet asked", which callers must not conflate. */
export function useRegisteredName(address: Address | null | undefined): { name: string | null; loaded: boolean } {
  const [state, setState] = useState<{ name: string | null; loaded: boolean }>({ name: null, loaded: false });
  useEffect(() => {
    if (!address) { setState({ name: null, loaded: true }); return; }
    let cancelled = false;
    void reverseAgentName(address)
      .then((name) => { if (!cancelled) setState({ name, loaded: true }); })
      .catch(() => { if (!cancelled) setState({ name: null, loaded: true }); });
    return () => { cancelled = true; };
  }, [address]);
  return state;
}
