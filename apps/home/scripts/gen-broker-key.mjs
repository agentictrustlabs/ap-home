// Generate an ES256 (ECDSA P-256) broker signing keypair and print the PRIVATE JWK + kid.
//
//   node apps/demo-sso/scripts/gen-broker-key.mjs
//
// Then set it as a Pages secret (the broker key is server-side only):
//   wrangler pages secret put BROKER_PRIVATE_JWK   # paste the privateJwk JSON
//   wrangler pages secret put BROKER_KID           # paste the kid
//
// Only the PUBLIC half is ever exposed (via GET /jwks); the private JWK stays
// a secret. Rotate by generating a new key + publishing both kids in the JWKS
// during the overlap window.

import { webcrypto as crypto } from 'node:crypto';

// ES256 (ECDSA P-256) — supported in workerd + browsers + Node (Ed25519 is NOT
// in the Cloudflare Workers Web Crypto runtime). spec 224 §4.
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
const kid = 'broker-' + Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex');

console.log('kid:', kid);
console.log('BROKER_PRIVATE_JWK (set as a Pages secret — keep it secret):');
console.log(JSON.stringify(privateJwk));
