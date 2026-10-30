// SEAL THE CUSTODY FILE FOR ITS OWNER — the last thing the build does, and the only way the file leaves it.
//
// `bootstrap-estate.mts` writes `.estate-<id>.local`: the estate's CUSTODY ROOT and every shared secret. The
// runbook's warning stands — it is the only copy of the root; losing it loses every resident's home, and copying it
// copies the authority to be every one of them. So the build never prints it, never uploads it in the clear, and
// never keeps it: it is sealed to a public key whose private half was generated in the OWNER's browser when they
// pressed "Create estate" and never left their machine, and only that sealed copy is handed to the site.
//
//   RSA-OAEP (SHA-256) wraps a fresh AES-256-GCM key; AES-GCM seals the file. WebCrypto on both ends, so the
//   site's page opens it with exactly the operations used here (site/public/custody.js is the other half).

const b64u = (bytes: ArrayBuffer | Uint8Array): string =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url');

export interface SealedBundle {
  v: 1;
  alg: 'RSA-OAEP-256+A256GCM';
  /** Who it is for — a fingerprint of the public key, so the page can say "this is not your key" before trying. */
  kid: string;
  wrappedKey: string;
  iv: string;
  ciphertext: string;
}

export async function keyFingerprint(publicJwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ e: publicJwk.e, kty: publicJwk.kty, n: publicJwk.n });
  return b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))).slice(0, 22);
}

export async function sealForOwner(plaintext: string, publicJwk: JsonWebKey): Promise<SealedBundle> {
  if (publicJwk.kty !== 'RSA' || !publicJwk.n || (Buffer.from(publicJwk.n, 'base64url').length * 8) < 2048) {
    throw new Error('the owner\'s key must be an RSA public key of at least 2048 bits');
  }
  const rsa = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: publicJwk.n, e: publicJwk.e, alg: 'RSA-OAEP-256', ext: true }, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey']);
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(plaintext));
  const wrappedKey = await crypto.subtle.wrapKey('raw', aes, rsa, { name: 'RSA-OAEP' });
  return { v: 1, alg: 'RSA-OAEP-256+A256GCM', kid: await keyFingerprint(publicJwk), wrappedKey: b64u(wrappedKey), iv: b64u(iv), ciphertext: b64u(ciphertext) };
}

/** Open a sealed bundle with the RSA private JWK it was sealed to (the build opening its town package). */
export async function openSealedWith(bundle: SealedBundle, privateJwk: JsonWebKey): Promise<string> {
  if (bundle?.v !== 1 || bundle.alg !== 'RSA-OAEP-256+A256GCM') throw new Error('not a sealed bundle');
  if (bundle.kid !== await keyFingerprint(privateJwk)) throw new Error('that bundle was sealed to a different key');
  const { kty, n, e, d, p, q, dp, dq, qi } = privateJwk;
  const rsa = await crypto.subtle.importKey('jwk', { kty, n, e, d, p, q, dp, dq, qi, alg: 'RSA-OAEP-256', ext: false }, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['unwrapKey']);
  const aes = await crypto.subtle.unwrapKey('raw', Buffer.from(bundle.wrappedKey, 'base64url'), rsa, { name: 'RSA-OAEP' }, { name: 'AES-GCM' }, false, ['decrypt']);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(bundle.iv, 'base64url') }, aes, Buffer.from(bundle.ciphertext, 'base64url')));
}
