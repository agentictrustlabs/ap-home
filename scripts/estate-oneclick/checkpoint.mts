// A BUILD THAT STOPS HALFWAY MUST RESUME WITH THE SAME KEYS.
//
// The workflow's machine is thrown away after every run, and `.estate-<id>.local` — the custody root and every
// secret bootstrap made — exists only on it. A re-dispatched build that could not find it would run bootstrap again
// and charter a SECOND set of agents under a second custody root, with the first set's secrets already installed on
// the Workers. So after every step the file is checkpointed to the site, sealed with a key only the build holds
// (BUILD_STATE_SECRET — a workflow secret the site never sees), and a resumed build fetches it back before it runs.
// The site keeps the opaque blob until the handover and then deletes it.
//
// Everything else a resumed build needs is in git: the declaration, the stamped wrangler blocks and the step state
// are committed to the branch `estate/<id>` after every step, and the workflow checks that branch out when it exists.

import { createHash } from 'node:crypto';
import { hmacSigner, type Signer } from './signer.mts';

const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');

async function keyFrom(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', createHash('sha256').update(`estate-oneclick-checkpoint:${secret}`).digest(), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Sealed FOR ONE ESTATE: its id is the AES-GCM additional data, so estate A's checkpoint never opens as estate B's. */
export async function sealState(plaintext: string, secret: string, estateId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(estateId) }, await keyFrom(secret), new TextEncoder().encode(plaintext));
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}

export async function openState(sealed: string, secret: string, estateId: string): Promise<string> {
  const [v, iv, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('not a build checkpoint');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64url'), additionalData: new TextEncoder().encode(estateId) }, await keyFrom(secret), Buffer.from(ct, 'base64url'));
  return new TextDecoder().decode(pt);
}

/** A signed GET to the site — the same signature as a progress report, over the request line. A string is the town's
 *  HMAC secret; a Signer is either kind. */
type Auth = string | Signer;
const signerOf = (a: Auth): Signer => (typeof a === 'string' ? hmacSigner(a) : a);
export async function signedGet(site: string, path: string, auth: Auth, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const ts = String(Date.now());
  const sig = await signerOf(auth).header(ts, `GET ${path}`);
  return fetchImpl(`${site.replace(/\/$/, '')}${path}`, { headers: { 'x-build-timestamp': ts, 'x-build-signature': sig } });
}

/** A signed POST (the town delivering an estate's sealed town package). */
export async function signedPost(site: string, path: string, body: string, auth: Auth, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const ts = String(Date.now());
  const sig = await signerOf(auth).header(ts, `POST ${path}.${body}`);
  return fetchImpl(`${site.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-build-timestamp': ts, 'x-build-signature': sig }, body });
}

/** Ask the site for the last checkpoint. */
export async function fetchCheckpoint(site: string, id: string, callbackSecret: Auth, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const res = await signedGet(site, `/api/estates/${encodeURIComponent(id)}/checkpoint`, callbackSecret, fetchImpl);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`the site would not return the checkpoint (${res.status})`);
  const body = (await res.json()) as { checkpoint?: string };
  return body.checkpoint ?? null;
}

export interface ApprovedRequest { requestId: string; id: string; name: string; estateName?: string; requestedBy: string; ownerKey: JsonWebKey; approvedBy: { address: string; name: string } }

/**
 * THE REQUEST THE BUILD RUNS comes from the site, never from the dispatch inputs. The site returns it only for an estate
 * a town operator approved, so a dispatch by anyone else — with any inputs — finds nothing to build.
 */
export async function fetchApproved(site: string, id: string, callbackSecret: Auth, fetchImpl: typeof fetch = fetch): Promise<ApprovedRequest> {
  const res = await signedGet(site, `/api/estates/${encodeURIComponent(id)}/approved`, callbackSecret, fetchImpl);
  if (!res.ok) throw new Error(`createestate has no approved request for "${id}" (${res.status}) — only an estate a town operator approved is built`);
  return (await res.json()) as ApprovedRequest;
}
