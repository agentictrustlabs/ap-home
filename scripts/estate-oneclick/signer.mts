// WHO A BUILD'S CALL TO THE SITE IS FROM — every call is signed over `<timestamp>.<METHOD> <path>[.<body>]`.
//
//   sha256=<hex>   HMAC with BUILD_CALLBACK_SECRET — the TOWN's builds (its GitHub and the site share the secret)
//   es256=<b64u>   ECDSA P-256 with the estate's BUILD KEY — a build on its owner's own accounts. The private half was
//                  made in the owner's browser and lives only in their GitHub secret ESTATE_BUILD_KEY; the site holds
//                  the public half. So the site holds no secret for builds it does not run.

import { createHmac } from 'node:crypto';

export interface Signer { header(timestamp: string, message: string): Promise<string> }

export const hmacSigner = (secret: string): Signer => ({
  header: async (ts, message) => `sha256=${createHmac('sha256', secret).update(`${ts}.${message}`).digest('hex')}`,
});

export async function ecSigner(privateJwk: JsonWebKey): Promise<Signer> {
  if (privateJwk.kty !== 'EC' || privateJwk.crv !== 'P-256' || !privateJwk.d) throw new Error('the build key\'s signing half must be a P-256 private key');
  const { kty, crv, x, y, d } = privateJwk;
  const key = await crypto.subtle.importKey('jwk', { kty, crv, x, y, d, ext: false }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return {
    header: async (ts, message) => {
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${ts}.${message}`));
      return `es256=${Buffer.from(sig).toString('base64url')}`;
    },
  };
}

/** The estate's build key, as the owner pasted it into ESTATE_BUILD_KEY: `{ enc: <RSA private JWK>, sig: <P-256 private JWK> }`. */
export interface BuildKey { estate?: string; enc: JsonWebKey; sig: JsonWebKey }

export function parseBuildKey(text: string): BuildKey {
  let k: BuildKey;
  try { k = JSON.parse(text) as BuildKey; } catch { throw new Error('ESTATE_BUILD_KEY is not the JSON file the site gave you'); }
  if (k?.enc?.kty !== 'RSA' || !k.enc.d || k?.sig?.kty !== 'EC' || !k.sig.d) throw new Error('ESTATE_BUILD_KEY must hold both private halves (enc and sig) — paste the whole build key file');
  return k;
}
