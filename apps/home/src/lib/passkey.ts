// Passkey (WebAuthn) flow — ported from demo-web. Registration ceremony
// (navigator.credentials.create → P-256 (x,y) + credentialIdDigest), signing
// ceremony (navigator.credentials.get → on-chain WebAuthn sig blob), localStorage
// persistence. Ceremony helpers from connect-auth/passkey; wire encoder from
// agent-account. Demo-only storage.
import { keccak256 } from 'viem';
import { parseAttestationObject, buildWebAuthnAssertion } from '@agenticprimitives/connect-auth/passkey';
import { encodeWebAuthnSignature } from '@agenticprimitives/agent-account';
import type { Hex } from '@agenticprimitives/types';

const STORAGE_KEY = 'agenticprimitives:demo-sso:passkey';

export interface DemoPasskey {
  credentialIdDigest: Hex; // keccak256(credentialId)
  credentialIdB64: string;
  pubKeyX: bigint;
  pubKeyY: bigint;
  label: string;
}

interface StoredPasskey {
  credentialIdDigest: Hex;
  credentialIdB64: string;
  pubKeyX: string;
  pubKeyY: string;
  label: string;
}

const toStored = (p: DemoPasskey): StoredPasskey => ({
  credentialIdDigest: p.credentialIdDigest,
  credentialIdB64: p.credentialIdB64,
  pubKeyX: p.pubKeyX.toString(),
  pubKeyY: p.pubKeyY.toString(),
  label: p.label,
});
const fromStored = (s: StoredPasskey): DemoPasskey => ({
  credentialIdDigest: s.credentialIdDigest,
  credentialIdB64: s.credentialIdB64,
  pubKeyX: BigInt(s.pubKeyX),
  pubKeyY: BigInt(s.pubKeyY),
  label: s.label,
});

export function loadPasskey(): DemoPasskey | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return fromStored(JSON.parse(raw) as StoredPasskey);
  } catch {
    return null;
  }
}
export function clearPasskey(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function b64uDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice((2 - (s.length & 3)) & 3);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hexToBytes(hex: Hex): Uint8Array {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(bytes: Uint8Array): Hex {
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex as Hex;
}

/** Register a new passkey (TouchID/FaceID/etc.) + persist (x,y) + digest. */
export async function registerPasskey(label: string): Promise<DemoPasskey> {
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new Error('WebAuthn unavailable — this browser does not support passkeys.');
  }
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);

  // The WebAuthn userHandle (`user.id`) MUST be STABLE for a given identity, NOT random. An
  // authenticator keys resident (discoverable) credentials by (rpId, userHandle): registering
  // with a userHandle that already exists REPLACES that passkey, but a fresh random handle each
  // time stacks a brand-new credential — so the OS picker lists the SAME name (e.g. `gco-v1.impact`)
  // once per signup attempt. Deriving the handle deterministically from (rpId, label) means a repeat
  // signup of the same identity overwrites its passkey instead of duplicating it.
  //
  // This is independent of the Smart Agent address: the SA derives from the passkey PUBLIC KEY
  // (credentialIdDigest / x,y) per ADR-0010 — the userHandle NEVER feeds the CREATE2 salt — so a
  // stable handle changes only the OS's credential bookkeeping, not the identity.
  const rpId = window.location.hostname;
  const userId = hexToBytes(keccak256(new TextEncoder().encode(`${rpId}|${label}`))).slice(0, 16);

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { id: rpId, name: 'Agentic Connect' },
      user: { id: userId, name: label, displayName: label },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 / P-256 ONLY (custody needs it; F9)
      // userVerification REQUIRED: the ROOT/primary passkey is custody-grade (security audit F9).
      // residentKey REQUIRED: the passkey must be discoverable so (a) the stable-userHandle overwrite
      // applies (a repeat signup REPLACES this identity's passkey instead of stacking a duplicate),
      // and (b) name-only / cross-device sign-in can find it (spec 233). We deliberately do NOT set
      // excludeCredentials: that would make a repeat registration throw InvalidStateError instead of
      // cleanly overwriting — the stable userHandle is what dedupes.
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('passkey registration cancelled');

  const response = credential.response as AuthenticatorAttestationResponse;
  const parsed = parseAttestationObject(new Uint8Array(response.attestationObject));
  const passkey: DemoPasskey = {
    credentialIdDigest: keccak256(bytesToHex(parsed.credentialId)),
    credentialIdB64: parsed.credentialIdBase64Url,
    pubKeyX: parsed.pubKeyX,
    pubKeyY: parsed.pubKeyY,
    label,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toStored(passkey)));
  return passkey;
}

/** Sign a 32-byte digest via WebAuthn → on-chain sig blob (0x01 || assertion).
 *  Uses the localStorage-cached credential (allowCredentials). Kept for flows
 *  that already hold the local passkey; prefer the discoverable variant for
 *  cross-device sign-in (spec 233). */
export async function signWithPasskey(digest: Hex): Promise<Hex> {
  const passkey = loadPasskey();
  if (!passkey) throw new Error('signWithPasskey: no registered passkey');
  return signAssertion(digest, b64uDecode(passkey.credentialIdB64));
}

/** Sign a 32-byte digest via a DISCOVERABLE passkey (spec 233, Mechanism A) —
 *  empty `allowCredentials`, no localStorage. The platform offers any passkey for
 *  this RP (including platform-synced ones on other devices); we read the chosen
 *  credentialId from `rawId`. The returned blob carries the credentialIdDigest,
 *  so the server verifies it on-chain via `getPasskey`/`isValidSignature` against
 *  the (name-resolved) agent SA — no client-supplied pubkey, no device cache.
 *
 *  SEC-015: when the caller knows which passkey SHOULD sign (e.g. an active session
 *  has a known custodian), pass `expectedCredentialIdDigest` and we'll reject any
 *  assertion whose rawId hash doesn't match. Catches the "platform offered a
 *  different passkey" UX confusion BEFORE the server round-trip + chain check. */
export async function signWithDiscoverablePasskey(
  digest: Hex,
  expectedCredentialIdDigest?: Hex,
): Promise<Hex> {
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new Error('WebAuthn unavailable — this browser does not support passkeys.');
  }
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: hexToBytes(digest) as BufferSource,
      allowCredentials: [], // discoverable: let the platform offer any passkey for this RP
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('no passkey available on this device');
  if (expectedCredentialIdDigest) {
    const offered = await sha256Hex(new Uint8Array(credential.rawId));
    if (offered.toLowerCase() !== expectedCredentialIdDigest.toLowerCase()) {
      throw new Error('passkey offered by the platform does not match the expected credential (SEC-015)');
    }
  }
  // The platform tells us which credential signed — use its rawId, not a cache.
  return signAssertionFromCredential(credential);
}

/** Named-CONNECT assertion (spec 233, Mechanism A): a single `get` that returns BOTH the on-chain
 *  signature blob AND the `credentialIdDigest` the server needs to resolve which custodian signed
 *  (keccak256 of the credentialId — matches registration). The server verifies the digest is an on-chain
 *  custodian of the name-resolved SA, so an unrelated passkey the platform might offer is rejected — no
 *  client-supplied pubkey.
 *
 *  LOCAL-FIRST HINT: when THIS browser cached the credential id, pass it as `allowCredentials` so the
 *  platform uses the LOCAL authenticator directly (Windows Hello / Touch ID) instead of the cross-device
 *  "use a phone" picker an EMPTY list triggers on Windows. `transports:['internal','hybrid']` keeps the
 *  SAME credential usable via a synced phone too, so it's a hint, not a per-browser pin. A browser with no
 *  cache passes `[]` (discoverable — the cross-browser/synced path 9fd8c03 added), so named sign-in still
 *  works anywhere the platform can surface the passkey. One `get`, one server verify — not a second
 *  mechanism/fallback (ADR-0013); the allowCredentials hint only biases the platform's chooser. */
export async function connectAssertionDiscoverable(digest: Hex): Promise<{ signature: Hex; credentialIdDigest: Hex }> {
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new Error('WebAuthn unavailable — this browser does not support passkeys.');
  }
  const cached = loadPasskey();
  const allowCredentials: PublicKeyCredentialDescriptor[] = cached?.credentialIdB64
    ? [{ id: b64uDecode(cached.credentialIdB64) as BufferSource, type: 'public-key', transports: ['internal', 'hybrid'] }]
    : []; // no local cache → discoverable (let the platform offer any passkey for this RP, incl. synced)
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: hexToBytes(digest) as BufferSource,
      allowCredentials,
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('no passkey available on this device');
  const credentialIdDigest = keccak256(bytesToHex(new Uint8Array(credential.rawId)));
  return { signature: signAssertionFromCredential(credential), credentialIdDigest };
}

async function sha256Hex(bytes: Uint8Array): Promise<Hex> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  let hex = '0x';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex as Hex;
}

async function signAssertion(digest: Hex, credentialIdBytes: Uint8Array): Promise<Hex> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: hexToBytes(digest) as BufferSource,
      allowCredentials: [{ id: credentialIdBytes as BufferSource, type: 'public-key' }],
      userVerification: 'required', // custody-grade signing — demand verification (F9)
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('passkey signing cancelled');
  // SEC-015 defensive: even with allowCredentials, verify the rawId matches what we
  // asked for. Catches a platform that would (incorrectly) ignore the allowlist.
  const offered = new Uint8Array(credential.rawId);
  if (offered.length !== credentialIdBytes.length || !offered.every((b, i) => b === credentialIdBytes[i])) {
    throw new Error('passkey offered by the platform does not match the registered credential (SEC-015)');
  }
  return signAssertionFromCredential(credential);
}

function signAssertionFromCredential(credential: PublicKeyCredential): Hex {
  const credentialIdBytes = new Uint8Array(credential.rawId);
  const response = credential.response as AuthenticatorAssertionResponse;
  const assertion = buildWebAuthnAssertion({
    credentialIdBytes,
    authenticatorData: new Uint8Array(response.authenticatorData),
    clientDataJSON: new Uint8Array(response.clientDataJSON),
    derSignature: new Uint8Array(response.signature),
  });
  return encodeWebAuthnSignature(assertion);
}
