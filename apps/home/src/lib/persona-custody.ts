'use client';
// Client half of demo-account custody (server: server/connect/persona-sign.ts).
//
// A demo person's home is a wallet-credential home whose wallet doesn't exist in this browser, so
// `signHashFor('wallet')` would open MetaMask — the wrong identity, and one nobody can approve.
// These helpers let the ceremony ask the Home to sign with the seeded custodian instead: the same
// zero-prompt shape a KMS home has, and identical on the wire (EIP-191 over the digest).
//
// The probe answers for the SESSION'S OWN person, so it is cached per session token; a `false`
// (the common case — every real user) costs one request per session and then never again.
import type { Hex } from '@agenticprimitives/types';

const probes = new Map<string, Promise<boolean>>();

async function ask(token: string, digest?: Hex): Promise<{ persona?: boolean; signature?: Hex; error?: string }> {
  const r = await fetch('/connect/persona-sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(digest ? { digest } : {}),
  });
  return (await r.json().catch(() => ({}))) as { persona?: boolean; signature?: Hex; error?: string };
}

/** Is the signed-in person a demo account this Home holds the custodian key for? */
export function isDemoCustodyHome(token: string): Promise<boolean> {
  const key = token.slice(-32);
  let p = probes.get(key);
  if (!p) {
    p = ask(token).then((b) => b.persona === true).catch(() => false);
    probes.set(key, p);
  }
  return p;
}

/** A SignHash bound to this session — the Home signs each digest with the demo custodian. */
export function demoCustodySignHash(token: string): (h: Hex) => Promise<Hex> {
  return async (h: Hex): Promise<Hex> => {
    const b = await ask(token, h);
    if (!b.signature) throw new Error(b.error ?? 'the demo custodian could not sign this');
    return b.signature;
  };
}
