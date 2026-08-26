// DEMO-PERSONA CUSTODY — the Home holds the seeded demo keys, so a demo user's home behaves like
// anyone else's.
//
// A demo persona (uupg's Nathan/David, the tracker's champions, New City's residents…) is a REAL
// on-chain Smart Agent whose custodian is a seeded EOA. Relying apps hold that key to mint the
// persona's site-login delegation — but at the PERSON'S OWN HOME every ceremony (enable vault
// storage, publish a directory listing, post in a discussion, claim a name) needs a custodian
// signature, and there is no wallet to give it: the demo apps' opener bridge only reaches as far as
// the tab it was opened from. So the persona hits a MetaMask prompt it can never satisfy.
//
// The fix is to put the key where the ceremonies are. `DEMO_PERSONA_KEYS` is a Home-side secret
// listing the demo SAs and their custodian keys; a Home session for one of those SAs can have the
// server sign digests for it — the same zero-prompt shape a KMS-custodied (Google/email) home has,
// working in any tab with no relying app in the loop. Every signature is still checked on-chain
// (ERC-1271 against the SA), so nothing about the trust story changes: the custodian signed.
//
// This is standard across demo apps BY CONSTRUCTION: the registry is keyed by Smart Agent, so any
// app whose demo users are these SAs gets it with no app-side code. Paste the same
// `demo-personas.secret.json` the apps use.
//
// Boundaries, deliberately narrow:
//   · OFF unless DEMO_PERSONA_KEYS is set (production Homes without it behave exactly as before).
//   · A caller can only ever sign as the SA in its OWN verified Home session — never another's.
//   · Only the listed SAs resolve; anything else falls through to the real wallet path.
//   · Demo keys only. A real user's custody NEVER lives here — that stays in their wallet, passkey,
//     or the KMS custodian derived from their credential.
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from '@agenticprimitives/types';
import type { Env } from './server-broker';

export type DemoPersona = {
  handle: string;
  sa: string;
  name?: string;
  blurb?: string;
  /** Orgs this demo person custodies, carried through from the app seeds (uupg's alliance gates
   *  read it). Opaque here — the Home stores and returns it, it never interprets it. */
  custodies?: { sa: string; name: string }[];
  privateKey: Hex;
};

/** Accepts the apps' seed shape `{handle: {sa, eoaPrivateKey, name}}` AND a flat
 *  `{"0x<sa>": "0x<privateKey>"}` map, so either can be pasted into the secret. */
function parseRegistry(raw: string | undefined): Map<string, DemoPersona> {
  const out = new Map<string, DemoPersona>();
  if (!raw) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return out; }
  if (!parsed || typeof parsed !== 'object') return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') {
      if (/^0x[0-9a-fA-F]{40}$/.test(key) && /^0x[0-9a-fA-F]{64}$/.test(value)) {
        out.set(key.toLowerCase(), { handle: key.toLowerCase(), sa: key.toLowerCase(), privateKey: value as Hex });
      }
      continue;
    }
    const v = value as { sa?: string; eoaPrivateKey?: string; privateKey?: string; name?: string; blurb?: string; custodies?: { sa: string; name: string }[] };
    const sa = (v.sa ?? '').toLowerCase();
    const pk = v.eoaPrivateKey ?? v.privateKey ?? '';
    if (!/^0x[0-9a-f]{40}$/.test(sa) || !/^0x[0-9a-fA-F]{64}$/.test(pk)) continue;
    out.set(sa, { handle: key, sa, name: v.name, blurb: v.blurb, custodies: Array.isArray(v.custodies) ? v.custodies : undefined, privateKey: pk as Hex });
  }
  return out;
}

let cached: { raw: string | undefined; map: Map<string, DemoPersona> } | null = null;
function registry(env: Env): Map<string, DemoPersona> {
  if (!cached || cached.raw !== env.DEMO_PERSONA_KEYS) {
    cached = { raw: env.DEMO_PERSONA_KEYS, map: parseRegistry(env.DEMO_PERSONA_KEYS) };
  }
  return cached.map;
}

/** The demo persona custodying `sa`, or null when this Home holds no key for it. Also accepts a
 *  handle (`nathan`) so an app can name a demo account without knowing its address. */
export function demoPersonaFor(env: Env, saOrHandle: string): DemoPersona | null {
  const k = saOrHandle.toLowerCase();
  const byAddress = registry(env).get(k);
  if (byAddress) return byAddress;
  for (const p of registry(env).values()) if (p.handle.toLowerCase() === k) return p;
  return null;
}

/** Every demo account this Home can act for (roster rendering — callers must not leak the key). */
export function listDemoPersonas(env: Env): DemoPersona[] {
  return [...registry(env).values()];
}

/** EIP-191 personal_sign over the RAW 32-byte digest — the same recovery a wallet produces
 *  (`AgentAccount._verifyEcdsa` accepts raw-or-EIP-191), so delegations, userOps and
 *  authorizations all verify unchanged. */
export async function signDigestAsDemoPersona(persona: DemoPersona, digest: Hex): Promise<Hex> {
  return privateKeyToAccount(persona.privateKey).signMessage({ message: { raw: digest } });
}

/** The custodian EOA address — PUBLIC (it's the on-chain custodian of the person's SA, and a deploy
 *  ceremony needs it as `custodians: [...]`). Derived from the key; the key itself never leaves. */
export function demoCustodianAddress(persona: DemoPersona): string {
  return privateKeyToAccount(persona.privateKey).address;
}

/** EIP-712 typed-data signature by the demo persona's custodian EOA. Used by relying apps whose
 *  ceremonies sign structured data rather than a raw digest (e.g. demo-web-pro's custody schedule/apply
 *  quorum slots). Same custodian, same on-chain authority; the key just lives here instead of a wallet. */
export async function signTypedDataAsDemoPersona(
  persona: DemoPersona,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typedData: { domain: any; types: any; primaryType: string; message: any },
): Promise<Hex> {
  return privateKeyToAccount(persona.privateKey).signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
}
