// THE HOLDER'S PROVER (private-scripture W4) — a Cloudflare Container beside the agent runtime, because the OpenAC 1k
// Prepare PROVING key is 274 MB and no Worker holds it. The runtime is its only caller (PROVER_SECRET).
//
// One call, POST /present: a person's anonymous credential + a verifier's proof request + the CHILD mandate the runtime
// derived from her standing `credential.present` wire for exactly this statement (one audience, one predicate program, one
// issuer facet, one presentation, minutes) → a presentation. Her device key lives in her key service and signs
// `ES256_SHA256` only under BOUND evidence; that evidence is minted here only after the presentation release has judged
// the mandate (on chain: signature, revocation, caveats) and allowed THIS digest for THIS venue and predicate. Without a
// mandate that covers the statement, nothing is signed. This service holds no wire of its own and decides nothing.
//
// PREPARE IS SLOW AND BIG (≈16 s, ≈45 MB) and a Prepare used twice links two presentations (`comm_W_shared`), so each is
// used ONCE. A small in-memory pool keeps one spare per (credential, predicate program), rebuilt in the background after
// each use; a container woken from sleep starts empty and the first presentation pays for its own Prepare.
//
//   GET  /health
//   POST /present   (Bearer PROVER_SECRET)  { credential, device, request, standing, mandate, actor } → { presentation }
//   POST /warm      (Bearer PROVER_SECRET)  { credential, request }  → prepares a spare in the background
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPublicClient, hashMessage, http as rpc } from 'viem';
import { compileOpenAcPredicates, prepareOpenAcCredential, presentOpenAc } from '@agenticprimitives/privacy-credentials';
import { createOpenAcBackend, OPENAC_SDK_VERSION, OPENAC_SDK_BUNDLE_VERSION } from '@agenticprimitives/privacy-credentials-openac';
import { createPresentationRelease, createEs256EvidenceMinter, boundEvidenceFrom, hashDelegation, intentDigest } from '@agenticprimitives/delegation';
import { createAkcsEs256Signer, staticTokenProvider, loadSecret } from '@agenticprimitives/key-custody';

const PORT = Number(process.env.PORT ?? 8080);
const KEYS = process.env.OPENAC_KEYS_DIR ?? '/keys';
const need = (k) => { const v = (process.env[k] ?? '').trim(); if (!v) { console.error(`${k} is required`); process.exit(2); } return v; };
const SECRET = need('PROVER_SECRET');
const HOLDER_TOKEN = need('AKCS_HOLDER_TOKEN');
const EVIDENCE_KEY = need('PRESENTATION_EVIDENCE_ES256_KEY');
const EVIDENCE_ISSUER = need('PRESENTATION_EVIDENCE_ISSUER');
const EVIDENCE_AUDIENCE = need('PRESENTATION_EVIDENCE_AUDIENCE');
const RPC_URL = need('RPC_URL');
const USV = need('UNIVERSAL_SIGNATURE_VALIDATOR');

const t0 = Date.now();
const file = (n) => readFile(join(KEYS, n)).then((b) => new Uint8Array(b));
const backend = await createOpenAcBackend({ keys: { '1k': { prepareProvingKey: await file('1k_prepare_proving.key'), prepareVerifyingKey: await file('1k_prepare_verifying.key'), showProvingKey: await file('1k_show_proving.key'), showVerifyingKey: await file('1k_show_verifying.key') } } });
console.log(`prover: 1k keys loaded in ${Date.now() - t0} ms · openac-sdk ${OPENAC_SDK_VERSION} · bundle ${OPENAC_SDK_BUNDLE_VERSION}`);
const evidence = boundEvidenceFrom(createEs256EvidenceMinter({ privateKeyHex: EVIDENCE_KEY, issuer: EVIDENCE_ISSUER, audience: EVIDENCE_AUDIENCE }));

const VALIDATOR = [{ type: 'function', name: 'isValidSig', stateMutability: 'view', inputs: [{ name: 'signer', type: 'address' }, { name: 'hash', type: 'bytes32' }, { name: 'sig', type: 'bytes' }], outputs: [{ type: 'bool' }] }];
const IS_REVOKED = [{ type: 'function', name: 'isRevoked', stateMutability: 'view', inputs: [{ name: 'delegationHash', type: 'bytes32' }], outputs: [{ type: 'bool' }] }];

/** The chain-side checks the release judges a mandate with, on the wire's own chain and delegation manager. */
function checksFor(chainId, delegationManager) {
  const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } };
  const pub = createPublicClient({ chain, transport: rpc(RPC_URL) });
  return {
    isRevoked: async (d) => pub.readContract({ address: delegationManager, abi: IS_REVOKED, functionName: 'isRevoked', args: [hashDelegation(d, chainId, delegationManager)] }),
    verifySignature: async ({ signer, digest, signature }) => pub.readContract({ address: USV, abi: VALIDATOR, functionName: 'isValidSig', args: [signer, hashMessage({ raw: digest }), signature] }),
    delegationDigest: (d) => hashDelegation(d, chainId, delegationManager),
  };
}

// ── the Prepare pool ─────────────────────────────────────────────────────────────────────────────────────────────
const pool = new Map(); // `${credentialDigest}|${predicateDigest}` → { ready: prepared[], building: Promise|null }
const POOL_DEPTH = 1;
const predicateDigestOf = (request) => { const c = compileOpenAcPredicates(request.predicates); if (!c.ok) throw new Error(`the predicate program does not compile: ${c.detail}`); return intentDigest(c.expression); };
const slotOf = (credential, request) => `${credential.digest}|${predicateDigestOf(request)}`;
async function prepareOne(credential, request) {
  const p = await prepareOpenAcCredential({ jwt: credential.jwt, disclosures: credential.disclosures, issuerPublicKeyJwk: credential.issuerPublicKeyJwk, request, backend });
  if (!p.ok) throw new Error(`Prepare refused: ${p.reason} ${p.detail ?? ''}`);
  return p.prepared;
}
function refill(credential, request) {
  const key = slotOf(credential, request);
  const s = pool.get(key) ?? { ready: [], building: null };
  pool.set(key, s);
  if (s.building || s.ready.length >= POOL_DEPTH) return;
  s.building = prepareOne(credential, request).then((p) => { s.ready.push(p); }).catch((e) => console.warn('[prover] background Prepare failed:', e.message)).finally(() => { s.building = null; });
}
/** A Prepare used by nobody before — from the pool, or made now. Never returned to the pool. */
async function takePrepared(credential, request) {
  const key = slotOf(credential, request);
  const s = pool.get(key);
  if (s?.ready.length) return s.ready.shift();
  if (s?.building) { await s.building; if (s.ready.length) return s.ready.shift(); }
  return prepareOne(credential, request);
}

async function present(body) {
  const { credential, device, request, standing, mandate, actor } = body;
  if (!credential?.jwt || !device?.keyId || !request || !standing?.wire || !mandate || !actor) return { status: 400, body: { error: 'credential, device, request, standing, mandate and actor are required' } };
  const predicateDigest = predicateDigestOf(request);
  const statement = { audience: request.audience, predicateDigest, issuerKeyId: credential.issuerKeyId };
  const m = { ...mandate, salt: BigInt(mandate.salt) };
  const decisions = [];
  const signer = await createAkcsEs256Signer(
    { baseUrl: device.baseUrl, tenantId: device.tenantId, tokenProvider: staticTokenProvider(loadSecret(HOLDER_TOKEN)), acceptedProtectionLevels: ['CVM_WRAPPED', 'CVM_DERIVED'] },
    { keyId: device.keyId, signingPurpose: 'ES256_SHA256' },
  );
  const release = createPresentationRelease({ mandate: m, actor, enforcers: standing.enforcers, checks: checksFor(Number(standing.chainId), standing.delegationManager), now: () => Math.floor(Date.now() / 1000), signer, evidence, onDecision: (d) => decisions.push(d.decision.decision) });
  const t = Date.now();
  const prepared = await takePrepared(credential, request);
  const tp = Date.now() - t;
  const shown = await presentOpenAc({ prepared, issuerKeyId: credential.issuerKeyId, request, device: { kind: 'signer', sign: (bytes) => release.sign(statement, bytes) }, backend });
  refill(credential, request);
  if (!shown.ok) return { status: 422, body: { error: `Show refused: ${shown.reason}`, detail: shown.detail, decisions } };
  return { status: 200, body: { presentation: shown.presentation, decisions, ms: { prepare: tp, total: Date.now() - t } } };
}

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
async function readBody(req) { let b = ''; for await (const c of req) { b += c; if (b.length > 2_000_000) throw new Error('too_large'); } return JSON.parse(b); }
http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://prover');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) return json(res, 200, { ok: true, service: 'ap-home-holder-prover', sdk: OPENAC_SDK_VERSION, bundleVersion: OPENAC_SDK_BUNDLE_VERSION, pooled: [...pool.values()].reduce((a, s) => a + s.ready.length, 0), rssMb: Math.round(process.memoryUsage().rss / 1048576), upSeconds: Math.round((Date.now() - t0) / 1000) });
  if (req.method !== 'POST' || (url.pathname !== '/present' && url.pathname !== '/warm')) return json(res, 404, { error: 'not_found' });
  if (req.headers.authorization !== `Bearer ${SECRET}`) return json(res, 401, { error: 'unauthorized' });
  let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: String(e.message ?? e) }); }
  try {
    if (url.pathname === '/warm') { if (!body?.credential?.jwt || !body?.request) return json(res, 400, { error: 'credential and request are required' }); refill(body.credential, body.request); return json(res, 202, { ok: true }); }
    const out = await present(body);
    return json(res, out.status, out.body);
  } catch (e) {
    console.error('[prover] present failed:', e);
    return json(res, 500, { error: 'present_failed', detail: e instanceof Error ? e.message : String(e) });
  }
}).listen(PORT, () => console.log(`prover: listening on ${PORT}`));
