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
  const userId = new Uint8Array(16);
  crypto.getRandomValues(userId);

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { id: window.location.hostname, name: 'Agentic Connect' },
      user: { id: userId, name: label, displayName: label },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 / P-256 ONLY (custody needs it; F9)
      // userVerification REQUIRED: the ROOT/primary passkey is custody-grade (security audit F9).
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
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

/** Sign a 32-byte digest via WebAuthn → on-chain sig blob (0x01 || assertion). */
export async function signWithPasskey(digest: Hex): Promise<Hex> {
  const passkey = loadPasskey();
  if (!passkey) throw new Error('signWithPasskey: no registered passkey');
  const credentialIdBytes = b64uDecode(passkey.credentialIdB64);
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: hexToBytes(digest) as BufferSource,
      allowCredentials: [{ id: credentialIdBytes as BufferSource, type: 'public-key' }],
      userVerification: 'required', // custody-grade signing — demand verification (F9)
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('passkey signing cancelled');
  const response = credential.response as AuthenticatorAssertionResponse;
  const assertion = buildWebAuthnAssertion({
    credentialIdBytes,
    authenticatorData: new Uint8Array(response.authenticatorData),
    clientDataJSON: new Uint8Array(response.clientDataJSON),
    derSignature: new Uint8Array(response.signature),
  });
  return encodeWebAuthnSignature(assertion);
}
