// WHICH CREDENTIAL IS CONNECTED — the one question the Ask surface answers on the person's behalf.
//
// A `credential` field (spec 350 §3.5) is never put to a human: they are signed in, and what they create
// they custody. This resolves the credential the session is actually holding into the material a genesis
// needs — a public key for a passkey, an address for a wallet or a KMS-custodied home — so the agent can
// predict the child SA the same way the Home's own ceremony does.
//
// It is DESCRIPTION, not authority: nothing here signs, and the chain still decides. A wrong answer
// produces an agent nobody can custody, which is why the agent verifies the credential custodies the
// connected person before it builds anything.
import type { Address, Hex } from '@agenticprimitives/types';
import { loadPasskey, passkeyRpId } from '../../../lib/passkey';
import { resolveCredential, cachedConnectionCustodian, demoCustodianFor } from '../../../connect-client';
import type { Via } from '../../../home/onboarding';

export type AskCredential =
  | { kind: 'eoa'; address: Address }
  | { kind: 'passkey'; credentialIdDigest: Hex; pubKeyX: string; pubKeyY: string; rpIdHash: Hex };

/** MUST equal what the SA's stored rpIdHash was derived from (`connect-client.derivePasskeyRpIdHash`):
 *  sha256 of the RP id the credential was created under. A mismatch orphans the agent. */
async function rpIdHash(): Promise<Hex> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(passkeyRpId()));
  return `0x${Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')}` as Hex;
}

export async function connectedCredential(via: Via, person: Address, token: string): Promise<AskCredential> {
  // A local passkey is the richest answer and the one whose SA derivation needs the most material.
  const pk = loadPasskey();
  if (via === 'passkey' && pk?.credentialIdDigest && pk.pubKeyX && pk.pubKeyY) {
    return { kind: 'passkey', credentialIdDigest: pk.credentialIdDigest, pubKeyX: pk.pubKeyX.toString(), pubKeyY: pk.pubKeyY.toString(), rpIdHash: await rpIdHash() };
  }
  // Wallet / KMS homes custody by an EOA — the wallet that signed in, or the per-(iss,sub) KMS custodian.
  const resolved = await resolveCredential(via, null, token).catch(() => null);
  if (resolved?.kind === 'eoa') return { kind: 'eoa', address: resolved.address };
  const cached = cachedConnectionCustodian(person);
  if (cached) return { kind: 'eoa', address: cached };
  // A seeded demo person has a wallet CREDENTIAL but no wallet in this browser — the Home holds the key.
  const demo = await demoCustodianFor(person).catch(() => null);
  if (demo) return { kind: 'eoa', address: demo };
  if (pk?.credentialIdDigest && pk.pubKeyX && pk.pubKeyY) {
    return { kind: 'passkey', credentialIdDigest: pk.credentialIdDigest, pubKeyX: pk.pubKeyX.toString(), pubKeyY: pk.pubKeyY.toString(), rpIdHash: await rpIdHash() };
  }
  throw new Error('This session has no credential this browser can describe — sign in with the credential that custodies you.');
}
