// demo-a2a as a Cloudflare Worker.
//
// Local dev:  wrangler dev (port 8787; reads .dev.vars for secrets + contract addrs)
// Production: wrangler deploy
//
// State is held in a Durable Object (SessionStoreDO); see ./session-store-do.ts.
// Env bindings come from c.env (typed via the Bindings interface below).

import { Hono } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import {
  verify as siweVerifyLegacy,
  verifyOnchain as siweVerifyOnchain,
} from '@agenticprimitives/identity-auth/siwe';
import {
  mintSession,
  verifySession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifyUserSignature,
  csrfTokenFor,
  verifyCsrf,
} from '@agenticprimitives/identity-auth';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import {
  BadInputError,
  badInputResponse,
  ensureArrayBound,
  parseAddress,
  parseAddressArray,
  parseBytes32,
  parseHex,
  parseOptionalAddress,
  parseOptionalUint256Decimal,
  parseUint256Decimal,
  parseUint48,
} from './validate';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import {
  buildKeyProvider,
  buildSignerBackend,
  buildMacProvider,
  type KmsBackend,
} from '@agenticprimitives/key-custody';
import { createKmsViemAccount } from '@agenticprimitives/key-custody/kms-viem';
import {
  SessionManager,
  hashDelegation,
  mintDelegationToken,
  type Delegation,
} from '@agenticprimitives/delegation';
import { generateServiceMac, bodyDigestHex } from '@agenticprimitives/mcp-runtime';
import {
  composeSinks,
  createConsoleAuditSink,
  type AuditSink,
} from '@agenticprimitives/audit';
import type { Address, Hex } from '@agenticprimitives/types';
import { SessionStoreDO, DurableObjectSessionStore } from './session-store-do';

/**
 * Audit sink for demo-a2a (C3 pass 5b). Console-only for now — demo-a2a has
 * no D1 binding, so audit rows surface in `wrangler tail`. demo-mcp persists
 * its half of the trail in D1. The system audit doc tracks "unify a2a + mcp
 * audit destination" as a follow-up (audit_id N15 candidate); the security
 * invariant satisfied today is "every signing/minting op produces an audit
 * event", regardless of destination.
 *
 * composeSinks isolates per-sink failures (when more sinks are added the
 * fan-out won't blackhole if one of them throws).
 */
function buildAuditSink(_env: Env): AuditSink {
  return composeSinks(createConsoleAuditSink({ prefix: '[AUDIT a2a]' }));
}

export { SessionStoreDO };

export interface Env {
  // Durable Object binding (declared in wrangler.toml)
  SESSIONS: DurableObjectNamespace;

  // Public config (wrangler.toml [vars])
  RPC_URL: string;
  CHAIN_ID: string;
  ALLOWED_ORIGINS: string;
  MCP_URL: string;
  /** Service binding to demo-mcp (production only; not set in local dev).
   *  Use env.MCP.fetch(...) instead of fetch(MCP_URL/...) — sibling
   *  Worker calls via workers.dev hit Cloudflare error 1042. */
  MCP?: Fetcher;

  // Contract addresses (.dev.vars locally; wrangler secret put for production)
  ENTRY_POINT: string;
  DELEGATION_MANAGER: string;
  AGENT_ACCOUNT_FACTORY: string;
  TIMESTAMP_ENFORCER: string;
  ALLOWED_TARGETS_ENFORCER: string;
  ALLOWED_METHODS_ENFORCER: string;
  VALUE_ENFORCER: string;
  // Naming service (spec 215). When set, /name/reverse resolves an SA
  // address → its primary `.agent` name via a single reverseResolveString
  // view call — no eth_getLogs walk, no fallback (ADR-0012 / ADR-0013).
  AGENT_NAME_REGISTRY?: string;
  AGENT_NAME_UNIVERSAL_RESOLVER?: string;
  /**
   * UniversalSignatureValidator address. When set, /auth/siwe-verify
   * uses the on-chain validator (handles EOA + ERC-1271 + ERC-6492
   * uniformly — required for passkey-owned smart accounts). When unset,
   * falls back to legacy ECDSA-only verification (EOA-owner flow only).
   *
   * Per spec 130 and the `demo-a2a is signer-agnostic` doctrine: with
   * the validator wired in, demo-a2a never inspects the signature bytes
   * — passkey vs EOA dispatch happens on-chain inside the validator.
   */
  UNIVERSAL_SIGNATURE_VALIDATOR?: string;
  /**
   * Optional. When set, /session/deploy + /session/deploy/submit are
   * enabled — users can deploy their smart accounts via UserOp sponsored
   * by this paymaster. When unset, lazy deploy is disabled and the demo
   * falls back to counterfactual mode (requireDeployed:false in demo-mcp).
   */
  PAYMASTER?: string;
  /**
   * Audit C2: when set, the paymaster is in verifying-paymaster mode
   * and demo-a2a must sign every paymaster envelope with the matching
   * KMS key. The value is the public address of the signer (must
   * match `paymaster.verifyingSigner()` on-chain). Unset → paymaster
   * is in dev/accept-all mode (local anvil only).
   */
  PAYMASTER_VERIFYING_SIGNER?: string;

  // Secrets (.dev.vars / wrangler secret put)
  SESSION_JWT_SECRETS: string;
  CSRF_SECRET: string;
  A2A_SESSION_SECRET: string;
  A2A_MASTER_PRIVATE_KEY: string;
  /**
   * Optional. When set, the worker's POST /admin/topup-paymaster endpoint
   * can move ETH from the deployer EOA to the paymaster's EntryPoint
   * deposit. This is how the operator refills the paymaster without
   * shelling into the deploy environment to run `cast send`. Off by
   * default — set via `wrangler secret put DEPLOYER_PRIVATE_KEY --env
   * production` (or in .dev.vars locally) when you want one-click
   * topups exposed in the demo UI.
   *
   * Even when set, the endpoint enforces caps:
   *   - Each topup ≤ 0.002 ETH
   *   - Refuses topup if paymaster deposit is already ≥ 0.005 ETH
   *   - At most one topup per 30 seconds across the worker
   * so a leaked endpoint cannot drain the deployer.
   */
  DEPLOYER_PRIVATE_KEY?: string;
  /**
   * Opt-in flag to allow LocalSecp256k1Signer (the in-memory secp256k1
   * signer backed by A2A_MASTER_PRIVATE_KEY) under NODE_ENV=production.
   * Set to "true" in [env.production.vars] so the demo's lazy
   * smart-account deploy + relayer paths work without standing up a
   * managed KMS. The signer logs a loud one-time warning when this
   * flag is in use. Must be removed before real-value keys land.
   */
  A2A_ALLOW_LOCAL_MASTER_KEY?: string;
  /**
   * Opt-in flag to allow LocalAesProvider envelope encryption
   * (generateSessionDataKey + decryptSessionDataKey) under
   * NODE_ENV=production. Required for the demo's SessionManager to
   * wrap session keypairs at rest. Stricter threat model than the
   * signer opt-in — compromise leaks every session key. MUST be
   * replaced by A2A_KMS_BACKEND=gcp-kms + GCP_KMS_ENCRYPT_KEY_NAME
   * before real-value keys land.
   */
  A2A_ALLOW_LOCAL_ENVELOPE_KEY?: string;
  /**
   * Shared HMAC secret used to sign A2A→MCP service-mac envelopes
   * (audit C1). Same 32-byte hex secret must be set on demo-mcp's
   * env so its verifier can recompute the MAC. For dev: generated by
   * `scripts/gen-dev-vars.ts`. For production: `wrangler secret put
   * A2A_MAC_SECRET --env production` on BOTH workers, OR swap in a
   * shared GCP KMS HMAC key via `buildMacProvider({backend:'gcp-kms', ...})`.
   */
  A2A_MAC_SECRET?: string;
  /** Full resource name of the symmetric Cloud KMS key for envelope
   *  encryption. Required when A2A_KMS_BACKEND=gcp-kms. */
  GCP_KMS_ENCRYPT_KEY_NAME?: string;
  /** Service-account JSON (set as wrangler secret). Same SA as the
   *  signing key; needs roles/cloudkms.cryptoKeyEncrypterDecrypter on
   *  GCP_KMS_ENCRYPT_KEY_NAME. */
  GCP_SERVICE_ACCOUNT_JSON?: string;
}

const MCP_AUDIENCE = 'urn:mcp:server:person';

// nodejs_compat exposes process.env; our packages read secrets from there.
// Mirror the Worker env into process.env at request entry so identity-auth +
// key-custody can resolve them without per-call wiring.
function bridgeEnvToProcessEnv(env: Env) {
  const keys = [
    'SESSION_JWT_SECRETS',
    'CSRF_SECRET',
    'A2A_SESSION_SECRET',
    'A2A_MASTER_PRIVATE_KEY',
    'A2A_ALLOW_LOCAL_MASTER_KEY',
    'A2A_ALLOW_LOCAL_ENVELOPE_KEY',
    'RPC_URL',
    'CHAIN_ID',
    'GCP_KMS_ENCRYPT_KEY_NAME',
    'GCP_SERVICE_ACCOUNT_JSON',
  ] as const;
  for (const k of keys) {
    const v = env[k];
    if (typeof v === 'string' && v.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.env as any)[k] = v;
    }
  }
  // Mark dev so the local-aes production guard doesn't fire on `wrangler dev`.
  // For real production, set NODE_ENV=production via wrangler.toml [env.production].
  if (!process.env.NODE_ENV) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.env as any).NODE_ENV = 'development';
  }
}

// ─── UserOp inner-revert detection ─────────────────────────────────────
//
// `handleOps` succeeds on the OUTER tx even when an inner userOp reverts —
// it just emits `UserOperationEvent(..., success=false)` and (if the
// revert had data) `UserOperationRevertReason(..., revertReason)`. Without
// parsing those events the client thinks the userOp landed when it
// actually no-op'd, which causes compound failures downstream (e.g.
// schedule silently fails → apply errors with ProposalNotFound).
//
// Parse the receipt for any UserOperationEvent and return `{ ok: false,
// userOpReverted: true, revertReason }` if any reverted.

const USER_OP_EVENT_TOPIC = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f' as const;
const USER_OP_REVERT_REASON_TOPIC = '0x1c4fada7374c0a9ee8841fc38afe82932dc0f8e69012e927f061a8bae611a201' as const;

interface InnerOpResult {
  ok: boolean;
  /** Set when an inner userOp reverted. Best-effort hex selector + args. */
  revertReason?: `0x${string}`;
}

function detectInnerOpFailure(receipt: {
  logs?: ReadonlyArray<{ address?: string; topics?: ReadonlyArray<string>; data?: string }>;
}): InnerOpResult {
  const logs = receipt.logs ?? [];
  let success = true;
  let revertReason: `0x${string}` | undefined;
  for (const log of logs) {
    const topic0 = log.topics?.[0]?.toLowerCase();
    if (topic0 === USER_OP_EVENT_TOPIC) {
      // data = (nonce, success, actualGasCost, actualGasUsed)
      // success is the second 32-byte word.
      const d = log.data ?? '0x';
      if (d.length >= 2 + 64 * 2) {
        // word 0 = nonce, word 1 = success (00..0 if false, 00..1 if true)
        const successWord = d.slice(2 + 64, 2 + 64 * 2);
        if (BigInt('0x' + successWord) === 0n) success = false;
      }
    } else if (topic0 === USER_OP_REVERT_REASON_TOPIC) {
      // data = abi.encode(bytes revertReason). Skip 32-byte offset + 32-byte length, read body.
      const d = log.data ?? '0x';
      if (d.length >= 2 + 64 * 2) {
        const lengthHex = d.slice(2 + 64, 2 + 64 * 2);
        const length = Number(BigInt('0x' + lengthHex));
        if (Number.isFinite(length) && length > 0) {
          revertReason = ('0x' + d.slice(2 + 64 * 2, 2 + 64 * 2 + length * 2)) as `0x${string}`;
        }
      }
    }
  }
  return { ok: success, revertReason };
}

const app = new Hono<{ Bindings: Env }>();

/**
 * CORS — exact-allowlist with credentials (audit P1-1).
 *
 * The previous `origin: (origin) => origin ?? '*'` reflected any inbound
 * Origin while enabling credentialed requests, which is a known unsafe
 * combination: a malicious page can issue cross-origin POSTs whose
 * cookies are honored by the worker. CSRF middleware downstream
 * helped, but defense-in-depth says: the CORS layer itself must be
 * exact-match when credentials are in play.
 *
 * `ALLOWED_ORIGINS` is a comma-separated list (e.g.
 * "https://demo.pages.dev,http://localhost:5173"). Origins not in the
 * set get an empty `Access-Control-Allow-Origin`, which browsers treat
 * as a CORS reject. Same-origin and credential-less server-to-server
 * calls don't carry an `Origin` header and pass through unaffected.
 */
function buildAllowedOriginMatcher(env: Env): (origin: string | undefined | null) => string {
  const raw = (env.ALLOWED_ORIGINS ?? '').trim();
  if (!raw) {
    // No allowlist configured. Refuse all cross-origin requests.
    // Boot misconfiguration: log loud once so it's visible at deploy time.
    console.warn(
      '[demo-a2a] CORS: ALLOWED_ORIGINS is empty — all cross-origin credentialed requests will be rejected. Set ALLOWED_ORIGINS in wrangler vars.',
    );
    return () => '';
  }
  const allowed = new Set<string>();
  for (const item of raw.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
        console.warn(`[demo-a2a] CORS: refusing non-https origin "${trimmed}" outside localhost`);
        continue;
      }
      allowed.add(u.origin);
    } catch {
      console.warn(`[demo-a2a] CORS: refusing malformed origin "${trimmed}"`);
    }
  }
  if (allowed.size === 0) {
    console.warn('[demo-a2a] CORS: ALLOWED_ORIGINS had no usable entries — all cross-origin requests will be rejected.');
  }
  return (origin) => (origin && allowed.has(origin) ? origin : '');
}

app.use('*', async (c, next) => {
  const match = buildAllowedOriginMatcher(c.env);
  return cors({
    origin: (origin) => match(origin),
    credentials: true,
  })(c, next);
});

app.use('*', async (c, next) => {
  bridgeEnvToProcessEnv(c.env);
  await next();
});

// CSRF middleware — audit H1.
//
// Double-submit cookie pattern: the browser fetches /auth/csrf once
// (returns a token + sets a non-HttpOnly cookie). For every mutating
// request, the browser sends the token both as a cookie AND as the
// `X-CSRF-Token` header. The middleware:
//  1. asserts header == cookie (timing-safe)
//  2. verifies the HMAC over the embedded origin+timestamp
//
// Skipped for:
//  - non-mutating methods (GET/HEAD/OPTIONS)
//  - /auth/csrf (the bootstrap GET that issues the token)
//
// Failure mode is fail-closed: missing/invalid CSRF → 403, never 200.
const CSRF_HEADER = 'X-CSRF-Token';
const CSRF_COOKIE = 'agentic-csrf';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

app.use('*', async (c, next) => {
  if (!MUTATING_METHODS.has(c.req.method)) return next();
  // /rpc is a read-only JSON-RPC pass-through (eth_call, eth_getCode,
  // etc.). No state change to forge → CSRF doesn't apply. We rely on
  // CORS to keep cross-origin browsers off non-allowlisted pages.
  if (c.req.path === '/rpc') return next();
  // Header double-submit + HMAC.
  const headerToken = c.req.header(CSRF_HEADER);
  const cookieToken = getCookie(c, CSRF_COOKIE);
  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return c.json({ error: 'csrf required' }, 403);
  }
  // Build allowed origins from ALLOWED_ORIGINS env (the same list SIWE
  // uses). Localhost variants always permitted for dev.
  const allowed = ['http://127.0.0.1:5173', 'http://localhost:5173'];
  for (const o of (c.env.ALLOWED_ORIGINS ?? '').split(',')) {
    const t = o.trim();
    if (t) allowed.push(t);
  }
  if (!verifyCsrf(headerToken, allowed)) {
    return c.json({ error: 'csrf invalid' }, 403);
  }
  return next();
});

// CSRF token issuer. GET so it bypasses the middleware. Sets the
// double-submit cookie (non-HttpOnly so JS can read it and echo it
// back as a header). The token's HMAC binds it to the request origin.
app.get('/auth/csrf', (c) => {
  const origin = c.req.header('origin') ?? c.req.header('referer') ?? '';
  if (!origin) return c.json({ error: 'origin header required' }, 400);
  // Parse origin → scheme://host[:port], reject if it doesn't look like a URL.
  let parsedOrigin: string;
  try {
    parsedOrigin = new URL(origin).origin;
  } catch {
    return c.json({ error: 'malformed origin' }, 400);
  }
  const token = csrfTokenFor(parsedOrigin);
  // SameSite=None is required for cross-origin clients (demo-web-pro
  // hits demo-a2a directly cross-site; demo-web proxies same-origin
  // via Pages Functions). 'None' requires Secure=true, which we get on
  // any https origin.
  const isHttps = parsedOrigin.startsWith('https://');
  setCookie(c, CSRF_COOKIE, token, {
    httpOnly: false, // JS reads this and echoes as X-CSRF-Token
    sameSite: isHttps ? 'None' : 'Lax',
    secure: isHttps,
    maxAge: 60 * 60, // 1 hour
    path: '/',
  });
  return c.json({ ok: true, token });
});

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'demo-a2a',
    chainId: Number(c.env.CHAIN_ID),
    factory: c.env.AGENT_ACCOUNT_FACTORY,
    runtime: 'cloudflare-workers',
  }),
);

/**
 * POST /rpc — JSON-RPC pass-through to the configured RPC backend.
 *
 * Lets browsers make eth_call / eth_getCode / etc. reads without:
 *   - exposing the upstream API key
 *   - tripping the upstream's CORS rejection (worker → upstream is
 *     server-to-server, no browser CORS involved)
 *   - hitting upstream rate limits as N individual browsers
 *
 * The browser sets `VITE_BROWSER_RPC_URL=<this worker>/rpc` and viem
 * sends standard JSON-RPC bodies. The worker forwards them verbatim
 * to RPC_URL and returns the response.
 *
 * CSRF: skipped here because (a) all JSON-RPC requests are POST and
 * the CSRF middleware applies to mutating methods, but read-only
 * `eth_call`s aren't a CSRF concern — there's no state change to
 * forge. We don't accept signed userOps via this endpoint; that's
 * what /account/submit-call-userop is for.
 */
app.post('/rpc', async (c) => {
  if (!c.env.RPC_URL) {
    return c.json({ jsonrpc: '2.0', error: { code: -32603, message: 'rpc_unconfigured' }, id: null }, 503);
  }
  const body = await c.req.text();
  // Allow CSRF middleware to bypass — it's a passthrough.
  // (Middleware already passed because the request arrived; the CSRF
  // gate is per-route, not global. /rpc deliberately doesn't gate.)
  try {
    const upstream = await fetch(c.env.RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return c.json({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'rpc_proxy_failed', data: String(e) },
      id: null,
    }, 502);
  }
});

app.get('/deployments', (c) =>
  c.json({
    chainId: Number(c.env.CHAIN_ID),
    delegationManager: c.env.DELEGATION_MANAGER,
    agentAccountFactory: c.env.AGENT_ACCOUNT_FACTORY,
    timestampEnforcer: c.env.TIMESTAMP_ENFORCER,
    allowedTargetsEnforcer: c.env.ALLOWED_TARGETS_ENFORCER,
    allowedMethodsEnforcer: c.env.ALLOWED_METHODS_ENFORCER,
    valueEnforcer: c.env.VALUE_ENFORCER,
    universalSignatureValidator: c.env.UNIVERSAL_SIGNATURE_VALIDATOR ?? null,
    agentNameRegistry: c.env.AGENT_NAME_REGISTRY ?? null,
    agentNameUniversalResolver: c.env.AGENT_NAME_UNIVERSAL_RESOLVER ?? null,
    // Note: RPC_URL is intentionally NOT exposed. When it embeds an
    // API key (Alchemy / Infura / etc.), the public /deployments
    // endpoint would leak it. The browser instead calls
    // /account/derive-address for any view-call address derivation.
  }),
);

/**
 * GET /name/reverse?address=0x… — resolve a Smart Agent address to its
 * primary `.agent` name, server-side, using the worker's RPC. The
 * relayer's naming surface: one `reverseResolveString` view call via the
 * package client — NO eth_getLogs walk, NO fallback to a second
 * resolution path (ADR-0012 / ADR-0013). Returns `{ address, name }`
 * where `name` is null when the SA has no primary name set.
 *
 * Lets any consumer label an address without embedding the naming
 * contract addresses or an RPC key in its own bundle.
 */
app.get('/name/reverse', async (c) => {
  const clientIp =
    c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  if (!checkRateLimit(clientIp)) {
    return c.json({ error: 'rate limit exceeded' }, 429);
  }
  const address = c.req.query('address');
  if (!address || !ADDRESS_REGEX.test(address)) {
    return c.json({ error: 'valid ?address=0x… required' }, 400);
  }
  if (
    !c.env.RPC_URL ||
    !c.env.CHAIN_ID ||
    !c.env.AGENT_NAME_REGISTRY ||
    !c.env.AGENT_NAME_UNIVERSAL_RESOLVER
  ) {
    return c.json({ error: 'naming not configured' }, 503);
  }
  try {
    const client = new AgentNamingClient({
      rpcUrl: c.env.RPC_URL,
      chainId: Number(c.env.CHAIN_ID),
      registry: c.env.AGENT_NAME_REGISTRY as `0x${string}`,
      universalResolver: c.env.AGENT_NAME_UNIVERSAL_RESOLVER as `0x${string}`,
    });
    const name = await client.reverseResolve(address as `0x${string}`);
    return c.json({ address, name });
  } catch (e) {
    return c.json({ error: 'reverse_resolve_failed', detail: String(e) }, 502);
  }
});

// View-call relay: derive a smart-account address from constructor
// args, server-side, using the demo-a2a's configured RPC. Lets the
// browser stay RPC-agnostic — the API key for the RPC provider never
// leaves the Worker. Per the `demo-a2a is signer-agnostic` doctrine:
// view-call relaying is permitted because no signature inspection
// happens here; only the factory method choice (which is a UserOp-
// construction concern, NOT a signature-verification concern).
// Audit N2: input validation + per-IP rate limit.
const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_REGEX = /^0x[0-9a-fA-F]{64}$/;
const UINT256_DECIMAL_REGEX = /^[0-9]{1,78}$/;
const UINT256_MAX = (1n << 256n) - 1n;

function tryUint256(s: string): bigint | null {
  if (!UINT256_DECIMAL_REGEX.test(s)) return null;
  let n: bigint;
  try {
    n = BigInt(s);
  } catch {
    return null;
  }
  if (n < 0n || n > UINT256_MAX) return null;
  return n;
}

// Simple per-IP token bucket. Sized for demo traffic; production
// should swap for a Durable Object or Cloudflare WAF rule.
const RATE_LIMIT_PER_MIN = 30;
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_PER_MIN) return false;
  bucket.count += 1;
  return true;
}

app.post('/account/derive-address', async (c) => {
  const clientIp =
    c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  if (!checkRateLimit(clientIp)) {
    return c.json({ error: 'rate limit exceeded' }, 429);
  }

  const body = (await c.req.json().catch(() => null)) as {
    initMethod?: 'eoa' | 'passkey';
    owner?: Address;
    credentialIdDigest?: Hex;
    pubKeyX?: string;
    pubKeyY?: string;
    salt?: string;
  } | null;
  if (!body) return c.json({ error: 'body required' }, 400);
  if (body.initMethod && body.initMethod !== 'eoa' && body.initMethod !== 'passkey') {
    return c.json({ error: 'initMethod must be "eoa" or "passkey"' }, 400);
  }

  // Validate salt (optional, defaults to 0).
  let salt = 0n;
  if (body.salt !== undefined) {
    const validated = tryUint256(body.salt);
    if (validated === null) {
      return c.json({ error: 'salt must be a decimal uint256 string' }, 400);
    }
    salt = validated;
  }

  try {
    let smartAccountAddress: Address;
    if (body.initMethod === 'passkey') {
      // Validate credentialIdDigest (bytes32 hex) + pubKey coords (uint256 decimal).
      if (
        typeof body.credentialIdDigest !== 'string' ||
        !BYTES32_REGEX.test(body.credentialIdDigest)
      ) {
        return c.json(
          { error: 'credentialIdDigest must be a 0x-prefixed 32-byte hex string' },
          400,
        );
      }
      const x = body.pubKeyX !== undefined ? tryUint256(body.pubKeyX) : null;
      const y = body.pubKeyY !== undefined ? tryUint256(body.pubKeyY) : null;
      if (x === null || y === null) {
        return c.json(
          { error: 'pubKeyX and pubKeyY must be decimal uint256 strings' },
          400,
        );
      }
      if (x === 0n || y === 0n) {
        return c.json({ error: 'pubKeyX and pubKeyY must be non-zero' }, 400);
      }
      smartAccountAddress = await accountClient(c.env).getAddressForAgentAccount({
        passkey: { credentialIdDigest: body.credentialIdDigest as Hex, x, y },
        salt,
      });
    } else {
      if (typeof body.owner !== 'string' || !ADDRESS_REGEX.test(body.owner)) {
        return c.json({ error: 'owner must be a 0x-prefixed 20-byte hex address' }, 400);
      }
      smartAccountAddress = await accountClient(c.env).getAddressForAgentAccount({
        custodians: [body.owner as Address],
        salt,
      });
    }
    return c.json({ ok: true, smartAccountAddress });
  } catch (e) {
    // Never echo internal error details to external callers — that
    // could leak chain state, RPC structure, etc.
    console.error('[/account/derive-address] failed:', e);
    return c.json({ error: 'address derivation failed' }, 500);
  }
});

// Surface the agent's master signing identity. This exercises the signer
// backend (LocalSecp256k1Signer or GcpKmsSigner) — it's the only endpoint
// that actually hits the master key, so it's the canonical smoke test for
// KMS migrations.
app.get('/agent/identity', async (c) => {
  const backend = (((process.env.A2A_KMS_BACKEND as KmsBackend | undefined) || 'local-aes')) as KmsBackend;
  try {
    // getSignerAddress doesn't sign, so no audit row emits here — pass the
    // sink anyway so this endpoint stays a faithful smoke test for the
    // production wiring.
    const signer = buildSignerBackend({ backend, auditSink: buildAuditSink(c.env) });
    const address = await signer.getSignerAddress();
    return c.json({ backend, address });
  } catch (err) {
    return c.json(
      { backend, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

// Audit N3: paymaster monitoring. Returns the current EntryPoint
// deposit balance for the configured paymaster + alert threshold
// status. Polled by a Cloudflare cron worker (or external monitor)
// to surface low-deposit conditions BEFORE users hit AA31 in the
// UX. Returns 503 when below the alert threshold so a simple
// uptime-monitor-style probe can trigger a page/alert without
// needing JSON parsing.
//
// Threshold is configurable via env PAYMASTER_ALERT_THRESHOLD_WEI.
// Default: 5e14 wei (0.0005 ETH ≈ ~2 EOA userOps at current Base
// Sepolia prices).
app.get('/paymaster/status', async (c) => {
  if (!c.env.PAYMASTER) {
    return c.json({ ok: false, error: 'paymaster not configured' }, 503);
  }
  const thresholdWei = BigInt(process.env.PAYMASTER_ALERT_THRESHOLD_WEI ?? '500000000000000');
  try {
    const publicClient = createPublicClient({ transport: http(c.env.RPC_URL) });
    const deposit = (await publicClient.readContract({
      address: c.env.ENTRY_POINT as Address,
      abi: [
        {
          type: 'function',
          name: 'balanceOf',
          stateMutability: 'view',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ type: 'uint256' }],
        },
      ] as const,
      functionName: 'balanceOf',
      args: [c.env.PAYMASTER as Address],
    })) as bigint;
    const lowDeposit = deposit < thresholdWei;
    return c.json(
      {
        ok: !lowDeposit,
        paymaster: c.env.PAYMASTER,
        entryPoint: c.env.ENTRY_POINT,
        depositWei: deposit.toString(),
        depositEth: (Number(deposit) / 1e18).toFixed(6),
        thresholdWei: thresholdWei.toString(),
        lowDeposit,
      },
      lowDeposit ? 503 : 200,
    );
  } catch (e) {
    return c.json(
      { ok: false, error: 'paymaster status check failed', detail: String(e) },
      500,
    );
  }
});

function accountClient(env: Env): AgentAccountClient {
  return new AgentAccountClient({
    rpcUrl: env.RPC_URL,
    chainId: Number(env.CHAIN_ID),
    entryPoint: env.ENTRY_POINT as Address,
    factory: env.AGENT_ACCOUNT_FACTORY as Address,
  });
}

function sessionManagerFor(env: Env, accountAddress: Address): SessionManager {
  // Pick the envelope-encryption backend by env:
  // - If A2A_KMS_BACKEND=gcp-kms AND GCP_KMS_ENCRYPT_KEY_NAME is configured,
  //   wrap session data keys with Cloud KMS Encrypt/Decrypt. Production-grade.
  // - Otherwise fall back to local-aes (dev backend; fails fast when
  //   NODE_ENV=production per its production guard).
  const backend = ((process.env.A2A_KMS_BACKEND as KmsBackend | undefined) || 'local-aes');
  const keyCustody =
    backend === 'gcp-kms' && env.GCP_KMS_ENCRYPT_KEY_NAME && env.GCP_SERVICE_ACCOUNT_JSON
      ? buildKeyProvider({
          backend: 'gcp-kms',
          config: {
            cryptoKeyName: env.GCP_KMS_ENCRYPT_KEY_NAME,
            serviceAccountJson: env.GCP_SERVICE_ACCOUNT_JSON,
          },
        })
      : buildKeyProvider({ backend: 'local-aes' });
  // Shard per-user: idFromName(accountAddress) → isolated DO instance.
  const store = new DurableObjectSessionStore(env.SESSIONS, accountAddress);
  return new SessionManager({ keyCustody, store });
}

// Extract the smart-account address from the JWT session cookie. Returns
// null if no cookie / invalid signature / expired. Used by routes that
// need to route to the correct per-user Durable Object.
function smartAccountFromCookie(c: { req: { raw: Request }; env?: unknown }): Address | null {
  // `getCookie` works on Hono Context; we use a narrowly-typed shape so
  // this helper can stay outside the closure if needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cookieValue = getCookie(c as any, SESSION_COOKIE);
  if (!cookieValue) return null;
  const claims = verifySession(cookieValue);
  return (claims?.smartAccountAddress as Address | undefined) ?? null;
}

// ─── STEP 1: SIWE login → JWT session ─────────────────────────────────────

app.post('/auth/siwe-verify', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    message?: string;
    signature?: Hex;
    name?: string;
    /**
     * Optional. When the SIWE `address` field is an EOA (legacy flow),
     * the smart account is derived from it via the factory. When the
     * SIWE `address` IS the smart account (passkey flow or any new
     * client built signer-agnostic), set this to true so we skip the
     * derivation and just verify the signature against the claimed
     * smart-account address.
     */
    addressIsSmartAccount?: boolean;
  } | null;
  if (!body || typeof body.message !== 'string' || typeof body.signature !== 'string') {
    return c.json({ error: 'message and signature required' }, 400);
  }

  // Allowed SIWE domains: local dev + any hostname extracted from
  // ALLOWED_ORIGINS (which is the deployed Pages URL in production).
  const allowedDomains = ['demo.agenticprimitives.local', '127.0.0.1', 'localhost'];
  for (const origin of (c.env.ALLOWED_ORIGINS ?? '').split(',')) {
    const trimmed = origin.trim();
    if (!trimmed) continue;
    try {
      allowedDomains.push(new URL(trimmed).hostname);
    } catch {
      // ignore malformed origin entries
    }
  }

  // Two verification modes:
  //   1. Signer-agnostic (preferred): UNIVERSAL_SIGNATURE_VALIDATOR is set →
  //      use verifyOnchain. Handles EOA, ERC-1271, and ERC-6492 uniformly.
  //   2. Legacy ECDSA-only: validator address missing → fall back to
  //      siweVerify (ECDSA recovery). EOA-only.
  let verifyResult: { ok: true; address: Address } | { ok: false; reason: string };
  if (c.env.UNIVERSAL_SIGNATURE_VALIDATOR) {
    const publicClient = createPublicClient({
      transport: http(c.env.RPC_URL),
    });
    const r = await siweVerifyOnchain(
      body.message,
      body.signature,
      async ({ signer, hash, signature }) =>
        verifyUserSignature({
          universalValidator: c.env.UNIVERSAL_SIGNATURE_VALIDATOR as Address,
          signer,
          hash,
          signature,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          client: publicClient as any,
        }),
      { allowedDomains },
    );
    verifyResult = r.ok ? { ok: true, address: r.address } : { ok: false, reason: r.reason };
  } else {
    const r = siweVerifyLegacy(body.message, body.signature, { allowedDomains });
    verifyResult = r.ok ? { ok: true, address: r.address } : { ok: false, reason: r.reason };
  }
  if (!verifyResult.ok) {
    return c.json({ error: 'siwe verify failed', reason: verifyResult.reason }, 401);
  }

  // Resolve the smart-account address. Two cases:
  //   - addressIsSmartAccount=true  → the SIWE message already names the
  //     smart account; use it directly. walletAddress=null (no EOA in
  //     the trust chain, e.g. passkey-owned account).
  //   - addressIsSmartAccount=false (legacy) → SIWE address is an EOA;
  //     derive the smart-account via factory.getAddress(eoa, 0).
  let walletAddress: Address | null;
  let smartAccountAddress: Address;
  if (body.addressIsSmartAccount) {
    walletAddress = null;
    smartAccountAddress = verifyResult.address;
  } else {
    walletAddress = verifyResult.address;
    try {
      smartAccountAddress = await accountClient(c.env).getAddressForAgentAccount({
        custodians: [walletAddress],
        salt: 0n,
      });
    } catch (e) {
      return c.json({ error: 'smart-account-address derivation failed', detail: String(e) }, 500);
    }
  }

  const isDeployed = await accountClient(c.env).isDeployed(smartAccountAddress).catch(() => false);

  const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : 'Demo User';
  const cookie = mintSession({
    sub: `did:ethr:${c.env.CHAIN_ID}:${smartAccountAddress}`,
    walletAddress,
    smartAccountAddress,
    name,
    email: null,
    via: 'siwe',
    kind: 'session',
  });

  setCookie(c, SESSION_COOKIE, cookie, {
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: SESSION_TTL_SECONDS,
    path: '/',
  });

  return c.json({ ok: true, walletAddress, smartAccountAddress, isDeployed });
});

// ─── STEP 1.5 (optional): deploy smart account via paymaster-sponsored UserOp ─────

/**
 * POST /session/deploy
 *
 * EOA path (legacy):
 *   Body: { initMethod?: 'eoa', owner: Address, salt?: string }
 *   Builds a UserOp whose initCode calls `createAccount(owner, salt)`.
 *
 * Passkey path (spec 130):
 *   Body: { initMethod: 'passkey', credentialIdDigest: Hex,
 *           pubKeyX: string, pubKeyY: string, salt?: string }
 *   Builds a UserOp whose initCode calls
 *   `createAccountWithPasskey(credentialIdDigest, x, y, salt)`. The
 *   deployed account has zero EOA owners — the passkey IS the owner.
 *
 * Returns: { userOp, userOpHash, sender } — for the client to sign
 * userOpHash. **demo-a2a does NOT inspect the signature** in the submit
 * step; the EntryPoint + AgentAccount validate it on-chain (passkey
 * dispatches through _verifyWebAuthn). The signer-agnostic doctrine
 * holds — only the factory-method choice is server-visible here.
 *
 * No-op (returns 409) if PAYMASTER env is unset.
 */
app.post('/session/deploy', async (c) => {
  if (!c.env.PAYMASTER) {
    return c.json({ error: 'paymaster not configured', detail: 'set PAYMASTER env to enable lazy deploy' }, 409);
  }
  const body = (await c.req.json().catch(() => null)) as {
    // New polymorphic shape: any combination of external custodians + a passkey.
    // The factory's createPersonAgent accepts mixed seeds in one shot.
    custodians?: Address[];
    passkey?: { credentialIdDigest: Hex; pubKeyX: string; pubKeyY: string };
    // Back-compat: legacy fields from the single-method era.
    initMethod?: 'eoa' | 'passkey';
    owner?: Address;
    credentialIdDigest?: Hex;
    pubKeyX?: string;
    pubKeyY?: string;
    salt?: string;
  } | null;
  if (!body) return c.json({ error: 'body required' }, 400);
  const salt = body.salt ? BigInt(body.salt) : 0n;
  // Normalize legacy + new shapes into PersonAgentSpec inputs.
  const custodians: Address[] =
    body.custodians ??
    (body.initMethod === 'eoa' && body.owner ? [body.owner as Address] : []);
  const passkeyInput =
    body.passkey ??
    (body.initMethod === 'passkey' && body.credentialIdDigest && body.pubKeyX && body.pubKeyY
      ? {
          credentialIdDigest: body.credentialIdDigest,
          pubKeyX: body.pubKeyX,
          pubKeyY: body.pubKeyY,
        }
      : null);
  if (custodians.length === 0 && !passkeyInput) {
    return c.json(
      { error: 'at least one of custodians[] or passkey must be supplied' },
      400,
    );
  }

  try {
    // Audit C2: when PAYMASTER_VERIFYING_SIGNER env is set (production
    // deploys), the paymaster is in verifying-paymaster mode and every
    // userOp's `paymasterAndData` must carry an EIP-191-wrapped
    // signature from that signer. We use the same KMS-backed master
    // (also the bundler signer); demo-a2a signs the canonical hash via
    // `signMessage({ raw })`. When the env is unset (anvil + local
    // dev), paymaster stays in dev/accept-all mode and no signature is
    // appended.
    let verifyingPaymaster:
      | { signFn: (hash: Hex) => Promise<Hex> }
      | undefined;
    if (c.env.PAYMASTER_VERIFYING_SIGNER) {
      const backend = ((process.env.A2A_KMS_BACKEND as KmsBackend | undefined) || 'local-aes');
      const kmsBackend = buildSignerBackend({ backend, auditSink: buildAuditSink(c.env) });
      const kmsAccount = await createKmsViemAccount(kmsBackend);
      verifyingPaymaster = {
        signFn: async (hash) => (await kmsAccount.signMessage({ message: { raw: hash } })) as Hex,
      };
    }

    const { userOp, userOpHash, sender } = await accountClient(c.env).buildDeployUserOpForAgentAccount({
      spec: {
        custodians,
        passkey: passkeyInput
          ? {
              credentialIdDigest: passkeyInput.credentialIdDigest,
              x: BigInt(passkeyInput.pubKeyX),
              y: BigInt(passkeyInput.pubKeyY),
            }
          : undefined,
        salt,
      },
      paymaster: c.env.PAYMASTER as Address,
      verifyingPaymaster,
    });
    return c.json({
      ok: true,
      sender,
      userOpHash,
      userOp: {
        ...userOp,
        nonce: userOp.nonce.toString(),
        preVerificationGas: userOp.preVerificationGas.toString(),
      },
    });
  } catch (e) {
    return c.json({ error: 'buildDeployUserOp failed', detail: String(e) }, 500);
  }
});

/**
 * POST /session/deploy/submit
 * Body: { userOp: PackedUserOperation (with signature filled) }
 * Returns: { deployedAddress, transactionHash }
 *
 * Submits via our own KMS-backed bundler: handleOps([signedUserOp]) on
 * the EntryPoint, paid (and reimbursed) by the configured paymaster.
 */
app.post('/session/deploy/submit', async (c) => {
  if (!c.env.PAYMASTER) {
    return c.json({ error: 'paymaster not configured' }, 409);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await c.req.json().catch(() => null)) as { userOp?: any } | null;
  if (!body?.userOp) return c.json({ error: 'userOp required' }, 400);

  // Re-hydrate bigints from string transit.
  const signedUserOp = {
    ...body.userOp,
    nonce: BigInt(body.userOp.nonce),
    preVerificationGas: BigInt(body.userOp.preVerificationGas),
  };

  try {
    const backend = ((process.env.A2A_KMS_BACKEND as KmsBackend | undefined) || 'local-aes');
    const kmsBackend = buildSignerBackend({ backend, auditSink: buildAuditSink(c.env) });
    const relayerAccount = await createKmsViemAccount(kmsBackend);
    const { deployedAddress, receipt } = await accountClient(c.env).submitDeployUserOp(
      signedUserOp,
      relayerAccount,
    );
    const inner = detectInnerOpFailure(
      receipt as unknown as Parameters<typeof detectInnerOpFailure>[0],
    );
    if (!inner.ok) {
      return c.json(
        {
          ok: false,
          error: 'userop_reverted',
          detail: inner.revertReason
            ? `inner userOp reverted with ${inner.revertReason}`
            : 'inner userOp reverted (no revertReason emitted)',
          transactionHash: receipt.transactionHash,
        },
        500,
      );
    }
    return c.json({
      ok: true,
      deployedAddress,
      transactionHash: receipt.transactionHash,
      status: receipt.status,
    });
  } catch (e) {
    console.error('[demo-a2a] submitDeployUserOp failed:', e);
    return c.json({ error: 'submitDeployUserOp failed', detail: String(e) }, 500);
  }
});

// ─── Gasless post-deploy calls (phase 6c.5-g) ─────────────────────────────
//
// Mirrors /session/deploy + /session/deploy/submit but for ALREADY-DEPLOYED
// AgentAccounts. The user signs the userOpHash; demo-a2a bundles + the
// paymaster sponsors gas. Together with the SDK's `buildCallUserOp` /
// `submitCallUserOp` helpers (packages/agent-account/src/client.ts) this
// is the foundation every gasless demo-web-pro flow runs on.

/**
 * POST /account/build-call-userop
 * Body: { sender: Address, callData: Hex }
 * Returns: { userOp, userOpHash, sender }
 *
 * Builds an unsigned PackedUserOperation targeting `sender` with the given
 * `callData`. callData is whatever the AgentAccount should execute — most
 * commonly `account.execute(target, value, data)` calldata so the user can
 * call ANY contract via their smart account. demo-a2a does NOT inspect or
 * restrict the callData; the on-chain `validateUserOp` (owner sig check)
 * is the auth boundary.
 *
 * No-op (409) if PAYMASTER env is unset.
 */
app.post('/account/build-call-userop', async (c) => {
  if (!c.env.PAYMASTER) {
    return c.json({ error: 'paymaster not configured' }, 409);
  }
  const body = (await c.req.json().catch(() => null)) as {
    sender?: Address;
    callData?: Hex;
  } | null;
  if (!body?.sender || !body?.callData) {
    return c.json({ error: 'sender + callData required' }, 400);
  }

  try {
    // Audit C2 verifying-paymaster mode (same as /session/deploy).
    let verifyingPaymaster:
      | { signFn: (hash: Hex) => Promise<Hex> }
      | undefined;
    if (c.env.PAYMASTER_VERIFYING_SIGNER) {
      const backend = ((process.env.A2A_KMS_BACKEND as KmsBackend | undefined) || 'local-aes');
      const kmsBackend = buildSignerBackend({ backend, auditSink: buildAuditSink(c.env) });
      const kmsAccount = await createKmsViemAccount(kmsBackend);
      verifyingPaymaster = {
        signFn: async (hash) => (await kmsAccount.signMessage({ message: { raw: hash } })) as Hex,
      };
    }

    const { userOp, userOpHash, sender } = await accountClient(c.env).buildCallUserOp({
      sender: body.sender,
      callData: body.callData,
      paymaster: c.env.PAYMASTER as Address,
      verifyingPaymaster,
    });
    return c.json({
      ok: true,
      sender,
      userOpHash,
      userOp: {
        ...userOp,
        nonce: userOp.nonce.toString(),
        preVerificationGas: userOp.preVerificationGas.toString(),
      },
    });
  } catch (e) {
    return c.json({ error: 'buildCallUserOp failed', detail: String(e) }, 500);
  }
});

/**
 * POST /account/submit-call-userop
 * Body: { userOp: PackedUserOperation (with signature filled) }
 * Returns: { transactionHash, status }
 */
app.post('/account/submit-call-userop', async (c) => {
  if (!c.env.PAYMASTER) {
    return c.json({ error: 'paymaster not configured' }, 409);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await c.req.json().catch(() => null)) as { userOp?: any } | null;
  if (!body?.userOp) return c.json({ error: 'userOp required' }, 400);

  const signedUserOp = {
    ...body.userOp,
    nonce: BigInt(body.userOp.nonce),
    preVerificationGas: BigInt(body.userOp.preVerificationGas),
  };

  try {
    const backend = ((process.env.A2A_KMS_BACKEND as KmsBackend | undefined) || 'local-aes');
    const kmsBackend = buildSignerBackend({ backend, auditSink: buildAuditSink(c.env) });
    const relayerAccount = await createKmsViemAccount(kmsBackend);
    const { receipt } = await accountClient(c.env).submitCallUserOp(signedUserOp, relayerAccount);
    const inner = detectInnerOpFailure(
      receipt as unknown as Parameters<typeof detectInnerOpFailure>[0],
    );
    if (!inner.ok) {
      return c.json(
        {
          ok: false,
          error: 'userop_reverted',
          detail: inner.revertReason
            ? `inner userOp reverted with ${inner.revertReason}`
            : 'inner userOp reverted (no revertReason emitted)',
          transactionHash: receipt.transactionHash,
        },
        500,
      );
    }
    return c.json({
      ok: true,
      transactionHash: receipt.transactionHash,
      status: receipt.status,
    });
  } catch (e) {
    console.error('[demo-a2a] submitCallUserOp failed:', e);
    return c.json({ error: 'submitCallUserOp failed', detail: String(e) }, 500);
  }
});

// ─── Direct factory deploy (SIWE-only seats) ──────────────────────────────
//
// For seats that enrol no passkey (wallet/SIWE only), no signer is
// available to produce a v=2 WebAuthn signature for the deploy userOp,
// and MetaMask won't sign a raw 32-byte userOpHash. We bypass ERC-4337
// entirely: the worker uses DEPLOYER_PRIVATE_KEY (same key that funds
// paymaster topups) to directly invoke `factory.createAgentAccount(...)`.
// The factory call is permissionless and registers the EOA as a
// custodian at proxy init. Worker pays gas — gasless to the user.
//
// Wave R0 collapsed the previous `/session/direct-deploy` (Person, mode=0)
// + `/session/direct-deploy-multisig` (mode>0) into one endpoint. Mode
// on the request body picks the shape — same axis the factory uses.
const DIRECT_DEPLOY_FACTORY_ABI = [
  {
    type: 'function',
    name: 'createAgentAccount',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'mode', type: 'uint8' },
          { name: 'custodians', type: 'address[]' },
          { name: 'trustees', type: 'address[]' },
          { name: 'initialPasskeyCredentialIdDigest', type: 'bytes32' },
          { name: 'initialPasskeyX', type: 'uint256' },
          { name: 'initialPasskeyY', type: 'uint256' },
        ],
      },
      { name: 'timelockOverrides', type: 'uint32[7]' },
      { name: 'salt', type: 'uint256' },
    ],
    outputs: [{ name: 'account', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getAddressForAgentAccount',
    stateMutability: 'view',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'mode', type: 'uint8' },
          { name: 'custodians', type: 'address[]' },
          { name: 'trustees', type: 'address[]' },
          { name: 'initialPasskeyCredentialIdDigest', type: 'bytes32' },
          { name: 'initialPasskeyX', type: 'uint256' },
          { name: 'initialPasskeyY', type: 'uint256' },
        ],
      },
      { name: 'salt', type: 'uint256' },
    ],
    outputs: [{ name: 'account', type: 'address' }],
  },
] as const;
const ZERO_BYTES32: Hex = ('0x' + '00'.repeat(32)) as Hex;

/**
 * POST /session/direct-deploy
 *
 * Unified direct-factory deploy. Body shape mirrors the contract's
 * `AgentAccountInitParams` + `(timelockOverrides, salt)`:
 *
 *   {
 *     mode: 0|1|2|3,
 *     custodians?: Address[],
 *     trustees?: Address[],          // required for mode > 0
 *     initialPasskeyCredentialIdDigest?: Hex,
 *     initialPasskeyX?: string,      // decimal uint256
 *     initialPasskeyY?: string,
 *     timelockOverrides?: number[],  // index t in 1..6 = per-tier override
 *                                    // (0 = factory default; T4=1h/T5=24h/T6=48h)
 *     salt: string,                  // decimal uint256
 *   }
 *
 * Permissionless: `factory.createAgentAccount(...)` accepts any caller,
 * so the worker just sends from the deployer EOA. CREATE2 yields the
 * same address as a passkey-userOp-deployed one for identical init params.
 */
app.post('/session/direct-deploy', async (c) => {
  try {
    if (!c.env.DEPLOYER_PRIVATE_KEY) {
      return c.json(
        { ok: false, error: 'deployer_key_missing', detail: 'DEPLOYER_PRIVATE_KEY required for direct deploy' },
        503,
      );
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ ok: false, error: 'bad_body' }, 400);

    let params: {
      mode: number;
      custodians: Address[];
      trustees: Address[];
      initialPasskeyCredentialIdDigest: Hex;
      initialPasskeyX: bigint;
      initialPasskeyY: bigint;
    };
    let timelockOverrides: readonly [number, number, number, number, number, number, number];
    let salt: bigint;
    try {
      // Validated shape: every field bounded + typed. No silent
      // `as Address` casts on attacker input (audit P1-3).
      const mode = body.mode === undefined ? 0 : parseUint48('mode', body.mode);
      if (mode > 3) throw new BadInputError('mode', 'mode > 3');
      const custodians = body.custodians === undefined ? [] : parseAddressArray('custodians', body.custodians);
      const trustees = body.trustees === undefined ? [] : parseAddressArray('trustees', body.trustees);
      const credId = body.initialPasskeyCredentialIdDigest === undefined
        ? ZERO_BYTES32
        : parseBytes32('initialPasskeyCredentialIdDigest', body.initialPasskeyCredentialIdDigest);
      const passkeyX = body.initialPasskeyX === undefined ? 0n : parseUint256Decimal('initialPasskeyX', body.initialPasskeyX);
      const passkeyY = body.initialPasskeyY === undefined ? 0n : parseUint256Decimal('initialPasskeyY', body.initialPasskeyY);
      const overrideSrc = Array.isArray(body.timelockOverrides) ? body.timelockOverrides : [];
      timelockOverrides = [0, 1, 2, 3, 4, 5, 6].map((i) => {
        const v = overrideSrc[i];
        return v === undefined ? 0 : parseUint48(`timelockOverrides[${i}]`, v);
      }) as unknown as readonly [number, number, number, number, number, number, number];
      salt = parseUint256Decimal('salt', body.salt);
      params = {
        mode,
        custodians,
        trustees,
        initialPasskeyCredentialIdDigest: credId,
        initialPasskeyX: passkeyX,
        initialPasskeyY: passkeyY,
      };
    } catch (e) {
      return badInputResponse(c, e) as Response;
    }

    const pkInput = c.env.DEPLOYER_PRIVATE_KEY.startsWith('0x')
      ? (c.env.DEPLOYER_PRIVATE_KEY as `0x${string}`)
      : (`0x${c.env.DEPLOYER_PRIVATE_KEY}` as `0x${string}`);
    const deployer = privateKeyToAccount(pkInput);
    const pub = createPublicClient({ chain: baseSepolia, transport: http(c.env.RPC_URL) });
    const wallet = createWalletClient({ account: deployer, chain: baseSepolia, transport: http(c.env.RPC_URL) });

    const predicted = (await pub.readContract({
      address: c.env.AGENT_ACCOUNT_FACTORY as Address,
      abi: DIRECT_DEPLOY_FACTORY_ABI,
      functionName: 'getAddressForAgentAccount',
      args: [params, salt],
    })) as Address;

    const code = await pub.getBytecode({ address: predicted });
    if (code && code !== '0x') {
      return c.json({
        ok: true,
        deployedAddress: predicted,
        transactionHash: ZERO_BYTES32,
        alreadyDeployed: true,
      });
    }

    const hash = await wallet.writeContract({
      address: c.env.AGENT_ACCOUNT_FACTORY as Address,
      abi: DIRECT_DEPLOY_FACTORY_ABI,
      functionName: 'createAgentAccount',
      args: [params, timelockOverrides, salt],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    return c.json({
      ok: true,
      deployedAddress: predicted,
      transactionHash: hash,
      status: receipt.status,
    });
  } catch (e) {
    console.error('[demo-a2a] direct-deploy failed:', e);
    return c.json(
      { ok: false, error: 'direct_deploy_failed', detail: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

// ─── Custody relay (SIWE-only signers) ────────────────────────────────────
//
// `CustodyPolicy.scheduleCustodyChange(...)` + `.applyCustodyChange(...)`
// validate quorum sigs over an EIP-712 hash; they DON'T constrain
// msg.sender. So for SIWE-only signers (who can't dispatch a userOp
// from their PSA without a passkey), the worker submits the call
// directly from its deployer EOA. Same gas-free UX for the user.

const CUSTODY_POLICY_ABI_REL = [
  {
    type: 'function',
    name: 'scheduleCustodyChange',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'action', type: 'uint8' },
      { name: 'args', type: 'bytes' },
      { name: 'quorumSigs', type: 'bytes' },
    ],
    outputs: [{ name: 'changeId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'applyCustodyChange',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'changeId', type: 'uint256' },
      { name: 'quorumSigs', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

function relayDeployer(env: Env) {
  if (!env.DEPLOYER_PRIVATE_KEY) return null;
  const pk = env.DEPLOYER_PRIVATE_KEY.startsWith('0x')
    ? (env.DEPLOYER_PRIVATE_KEY as `0x${string}`)
    : (`0x${env.DEPLOYER_PRIVATE_KEY}` as `0x${string}`);
  return privateKeyToAccount(pk);
}

app.post('/session/custody-schedule', async (c) => {
  try {
    const deployer = relayDeployer(c.env);
    if (!deployer) return c.json({ ok: false, error: 'deployer_key_missing' }, 503);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ ok: false, error: 'bad_body' }, 400);
    let custodyPolicy: Address;
    let account: Address;
    let action: number;
    let args: Hex;
    let quorumSigs: Hex;
    try {
      custodyPolicy = parseAddress('custodyPolicy', body.custodyPolicy);
      account = parseAddress('account', body.account);
      action = parseUint48('action', body.action);
      if (action > 255) throw new BadInputError('action', 'action exceeds uint8');
      args = parseHex('args', body.args, { maxBytes: 4096 });
      // Quorum sig blob: bounded at 32 KiB (multi-slot quorum + tails;
      // realistic max ~1 KiB; cap is loose-but-finite).
      quorumSigs = parseHex('quorumSigs', body.quorumSigs, { maxBytes: 32768 });
    } catch (e) {
      return badInputResponse(c, e) as Response;
    }

    const pub = createPublicClient({ chain: baseSepolia, transport: http(c.env.RPC_URL) });
    const wallet = createWalletClient({ account: deployer, chain: baseSepolia, transport: http(c.env.RPC_URL) });
    const hash = await wallet.writeContract({
      address: custodyPolicy,
      abi: CUSTODY_POLICY_ABI_REL,
      functionName: 'scheduleCustodyChange',
      args: [account, action, args, quorumSigs],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    return c.json({ ok: true, transactionHash: hash, status: receipt.status });
  } catch (e) {
    console.error('[demo-a2a] custody-schedule failed:', e);
    return c.json(
      { ok: false, error: 'custody_schedule_failed', detail: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

app.post('/session/custody-apply', async (c) => {
  try {
    const deployer = relayDeployer(c.env);
    if (!deployer) return c.json({ ok: false, error: 'deployer_key_missing' }, 503);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ ok: false, error: 'bad_body' }, 400);
    let custodyPolicy: Address;
    let account: Address;
    let changeId: bigint;
    let quorumSigs: Hex;
    try {
      custodyPolicy = parseAddress('custodyPolicy', body.custodyPolicy);
      account = parseAddress('account', body.account);
      changeId = parseUint256Decimal('changeId', body.changeId);
      quorumSigs = parseHex('quorumSigs', body.quorumSigs, { maxBytes: 32768 });
    } catch (e) {
      return badInputResponse(c, e) as Response;
    }

    const pub = createPublicClient({ chain: baseSepolia, transport: http(c.env.RPC_URL) });
    const wallet = createWalletClient({ account: deployer, chain: baseSepolia, transport: http(c.env.RPC_URL) });
    const hash = await wallet.writeContract({
      address: custodyPolicy,
      abi: CUSTODY_POLICY_ABI_REL,
      functionName: 'applyCustodyChange',
      args: [account, changeId, quorumSigs],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    return c.json({ ok: true, transactionHash: hash, status: receipt.status });
  } catch (e) {
    console.error('[demo-a2a] custody-apply failed:', e);
    return c.json(
      { ok: false, error: 'custody_apply_failed', detail: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

// ─── MCP-style delegation-gated data endpoints (phase 6f.6 LIVE) ──────────
//
// Two endpoints exercise the off-chain Variant A delegation path end-to-end:
//   - POST /mcp/person/pii        → returns mock PII for `delegator` (a
//                                    Person Smart Agent), if the supplied
//                                    delegation proves the caller (delegate)
//                                    has read-PII authority from that PSA.
//   - POST /mcp/org/sensitive     → returns mock Org-internal data, if the
//                                    supplied delegation is signed by the Org
//                                    smart account naming the caller as delegate.
//
// Verification path:
//   1. Recompute the EIP-712 delegation hash against the deployed
//      AgentDelegationManager domain.
//   2. Call `delegator.isValidSignature(hash, delegation.signature)` —
//      ERC-1271 query against the on-chain smart account. Returns the
//      magic value 0x1626ba7e on success.
//   3. Walk the delegation's timestamp caveat — reject if expired or
//      not-yet-valid.
//   4. Audit the verdict on chain via the typical worker logging.
//
// Anything fancier (full DelegationToken envelopes, on-chain enforcer
// invocation, multi-step delegation chains) is out of scope for this
// pass; the simpler shape here is what the demo needs to be honest.

const AGENT_DELEGATION_MANAGER_TYPES = {
  Delegation: [
    { name: 'delegator', type: 'address' },
    { name: 'delegate', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'Caveat[]' },
    { name: 'salt', type: 'uint256' },
  ],
  Caveat: [
    { name: 'enforcer', type: 'address' },
    { name: 'terms', type: 'bytes' },
    { name: 'args', type: 'bytes' },
  ],
} as const;

const ERC1271_ABI = [
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [
      { name: 'hash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: 'magic', type: 'bytes4' }],
  },
] as const;
const ERC1271_MAGIC = '0x1626ba7e';

interface IncomingCaveat {
  enforcer: Address;
  terms: Hex;
  args?: Hex;
}
interface IncomingDelegation {
  delegator: Address;
  delegate: Address;
  authority: Hex;
  caveats: IncomingCaveat[];
  salt: string; // bigint as string
  signature: Hex;
}

async function verifyDelegation(
  env: Env,
  delegation: IncomingDelegation,
  expectedDelegate: Address,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!env.DELEGATION_MANAGER) {
    return { ok: false, reason: 'DELEGATION_MANAGER env not configured' };
  }
  if (delegation.delegate.toLowerCase() !== expectedDelegate.toLowerCase()) {
    return {
      ok: false,
      reason: `delegate mismatch — token names ${delegation.delegate}, request from ${expectedDelegate}`,
    };
  }
  // Walk timestamp caveat (first 4 bytes of terms are an ABI-encoded
  // pair of uint128s for validAfter/validUntil per the enforcer's
  // canonical shape). Other caveats are descriptive in this slice
  // (target / method / value); the worker does NOT execute on-chain,
  // so it just checks the time window. Anything we leave un-checked
  // here would re-fire on the on-chain redeem path in a later phase.
  const now = Math.floor(Date.now() / 1000);
  for (const c of delegation.caveats) {
    if (c.enforcer.toLowerCase() === (env.TIMESTAMP_ENFORCER ?? '').toLowerCase()) {
      try {
        // terms = abi.encode(uint128 validAfter, uint128 validUntil)
        const bytes = c.terms.startsWith('0x') ? c.terms.slice(2) : c.terms;
        const validAfter = parseInt(bytes.slice(0, 64), 16);
        const validUntil = parseInt(bytes.slice(64, 128), 16);
        if (now < validAfter) {
          return { ok: false, reason: `delegation not yet valid (validAfter=${validAfter} now=${now})` };
        }
        if (now >= validUntil) {
          return { ok: false, reason: `delegation expired (validUntil=${validUntil} now=${now})` };
        }
      } catch { /* malformed terms — fall through to signature check */ }
    }
  }
  // ERC-1271 verify against the delegator smart account.
  const pub = createPublicClient({ chain: baseSepolia, transport: http(env.RPC_URL) });
  const domain = {
    name: 'AgentDelegationManager',
    version: '1',
    chainId: 84532,
    verifyingContract: env.DELEGATION_MANAGER as Address,
  };
  const { hashTypedData } = await import('viem');
  const digest = hashTypedData({
    domain,
    types: AGENT_DELEGATION_MANAGER_TYPES,
    primaryType: 'Delegation',
    message: {
      delegator: delegation.delegator,
      delegate: delegation.delegate,
      authority: delegation.authority,
      caveats: delegation.caveats.map((c) => ({
        enforcer: c.enforcer,
        terms: c.terms,
        args: (c.args ?? '0x') as Hex,
      })),
      salt: BigInt(delegation.salt),
    },
  });
  try {
    const magic = (await pub.readContract({
      address: delegation.delegator,
      abi: ERC1271_ABI,
      functionName: 'isValidSignature',
      args: [digest, delegation.signature],
    })) as Hex;
    if (magic.toLowerCase() !== ERC1271_MAGIC) {
      return { ok: false, reason: `ERC-1271 returned ${magic} (expected ${ERC1271_MAGIC})` };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: `ERC-1271 call to delegator failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Run the full session → token → service-MAC → demo-mcp tool-call chain
 * for a delegation-gated MCP tool. Shared by the PII + Org-sensitive
 * orchestrators below.
 *
 * Steps:
 *   1. ERC-1271-verify the Variant A delegation on the delegator
 *      smart account. Reject early if invalid.
 *   2. Open a fresh session on the requester's (delegate's) Durable
 *      Object. The session's signing key is HSM-wrapped via
 *      `key-custody` — local-aes in dev, GCP-KMS in production.
 *   3. Package the delegation envelope into the session. The session
 *      record now holds the delegation + the wrapped session key.
 *   4. Resolve the session, mint a DelegationToken signed by the
 *      session key (sub = delegator, sessionKey = signer address,
 *      aud = mcp). Audit-emit `delegation.mint`.
 *   5. Wrap in a service-MAC envelope (audit C1). demo-mcp checks the
 *      MAC before parsing the body.
 *   6. Worker-to-worker call to demo-mcp's `/tools/<name>`. demo-mcp
 *      verifies the token via `withDelegation`, runs the fail-closed
 *      caveat evaluator, calls the registered tool handler, and
 *      returns the record from D1.
 *   7. Audit-emit `delegation.verify.accept|reject` happens inside
 *      `withDelegation` on the MCP side.
 */
async function callMcpToolViaDelegation(args: {
  env: Env;
  toolName: 'get_pii' | 'get_org_sensitive';
  delegation: IncomingDelegation;
  requester: Address;
}): Promise<Response> {
  // 1. ERC-1271 pre-check (clearer error than waiting for the MCP-side
  //    rejection; same proof either way).
  const verify = await verifyDelegation(args.env, args.delegation, args.requester);
  if (!verify.ok) {
    return new Response(
      JSON.stringify({ ok: false, error: 'delegation_invalid', detail: verify.reason }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const auditSink = buildAuditSink(args.env);
  const correlationId = crypto.randomUUID();

  const sm = sessionManagerFor(args.env, args.requester);
  const initRes = await sm.init(args.requester, Number(args.env.CHAIN_ID));

  const delegationStruct: Delegation = {
    delegator: args.delegation.delegator,
    delegate: args.delegation.delegate,
    authority: args.delegation.authority,
    caveats: args.delegation.caveats.map((c) => ({
      enforcer: c.enforcer,
      terms: c.terms,
      args: (c.args ?? '0x') as Hex,
    })),
    salt: BigInt(args.delegation.salt),
    signature: args.delegation.signature,
  };
  await sm.package(initRes.sessionId, delegationStruct);

  const resolved = await sm.resolve(initRes.sessionId);
  if (!resolved.delegation) {
    return new Response(
      JSON.stringify({ ok: false, error: 'session_resolve_no_delegation' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 4. Mint the delegation token signed by the session key.
  const { token } = await mintDelegationToken(
    {
      iss: 'demo-a2a',
      aud: MCP_AUDIENCE,
      sub: resolved.delegation.delegator,
      delegation: resolved.delegation,
      sessionKeyAddress: resolved.signer.address,
      ttlSeconds: 300,
      usageLimit: 10,
    },
    (msg) => resolved.signer.signMessage(msg),
    { auditSink, correlationId },
  );

  // 5. Service-MAC envelope for the worker-to-worker call.
  const requestBody = JSON.stringify({ token, args: {} });
  const macProvider = buildMacProvider(MCP_AUDIENCE, {
    backend: 'local-aes',
    config: { sessionSecretHex: args.env.A2A_MAC_SECRET ?? '' },
    auditSink,
  });
  const macHeaders = await generateServiceMac({
    ctx: {
      audience: MCP_AUDIENCE,
      service: 'a2a-to-mcp',
      route: args.toolName,
      bodyDigest: bodyDigestHex(requestBody),
    },
    provider: macProvider,
  });
  const reqInit: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-A2A-Mac': macHeaders.mac,
      'X-A2A-Mac-Nonce': macHeaders.nonce,
      'X-A2A-Mac-Timestamp': macHeaders.timestamp,
      'X-A2A-Mac-Key-Id': macHeaders.keyId,
      'X-Correlation-Id': correlationId,
    },
    body: requestBody,
  };
  // 6. Call the MCP server. Prefer the service binding in production
  //    (avoids Cloudflare error 1042 on sibling-Worker fetches); fall
  //    back to public-URL fetch in local dev.
  const mcpRes = args.env.MCP
    ? await args.env.MCP.fetch(new Request(`https://internal/tools/${args.toolName}`, reqInit))
    : await fetch(`${args.env.MCP_URL}/tools/${args.toolName}`, reqInit);
  const mcpBody = await mcpRes.text();
  // Pass through demo-mcp's response. On a non-2xx, wrap the body so
  // the front-end sees a consistent { ok: false, error, detail } shape.
  if (!mcpRes.ok) {
    let detail = mcpBody;
    let error = `mcp_${mcpRes.status}`;
    try {
      const parsed = JSON.parse(mcpBody) as { error?: string; detail?: string };
      if (parsed.error) error = parsed.error;
      if (parsed.detail) detail = parsed.detail;
    } catch { /* keep raw body */ }
    return new Response(
      JSON.stringify({ ok: false, error, detail, mcp_status: mcpRes.status }),
      { status: mcpRes.status, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return new Response(mcpBody, {
    status: mcpRes.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

app.post('/mcp/person/pii', async (c) => {
  try {
    const body = (await c.req.json().catch(() => null)) as {
      delegation: IncomingDelegation;
      requester: Address;
    } | null;
    if (!body?.delegation || !body?.requester) {
      return c.json({ ok: false, error: 'bad_body' }, 400);
    }
    return await callMcpToolViaDelegation({
      env: c.env,
      toolName: 'get_pii',
      delegation: body.delegation,
      requester: body.requester,
    });
  } catch (e) {
    return c.json(
      { ok: false, error: 'pii_lookup_failed', detail: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

app.post('/mcp/org/sensitive', async (c) => {
  try {
    const body = (await c.req.json().catch(() => null)) as {
      delegation: IncomingDelegation;
      requester: Address;
    } | null;
    if (!body?.delegation || !body?.requester) {
      return c.json({ ok: false, error: 'bad_body' }, 400);
    }
    return await callMcpToolViaDelegation({
      env: c.env,
      toolName: 'get_org_sensitive',
      delegation: body.delegation,
      requester: body.requester,
    });
  } catch (e) {
    return c.json(
      { ok: false, error: 'org_data_failed', detail: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

// ─── Paymaster top-up (operator-only) ─────────────────────────────────────
//
// One-click "send ETH from the deployer EOA to the paymaster's EntryPoint
// deposit." Used by the demo's top-bar gas readout: when the paymaster
// runs low, clicking the ⛽ pill calls this endpoint instead of forcing
// the operator to shell into the deploy env to run `cast send`.
//
// Safety caps (the deployer key is hot — this endpoint must NOT be a
// drain vector):
//   - Endpoint is OFF unless `DEPLOYER_PRIVATE_KEY` is set as a secret.
//   - Per-call ≤ 0.002 ETH (TOPUP_MAX_WEI below).
//   - Refuses topup when paymaster.balanceOf(EntryPoint) is already
//     ≥ 0.005 ETH (TOPUP_TARGET_FLOOR — leaves plenty of headroom
//     before the next refill).
//   - At most 1 topup per 30s per worker isolate (lastTopupAt).
// CSRF-protected (the global middleware enforces).

const TOPUP_MAX_WEI = 2_000_000_000_000_000n;        // 0.002 ETH
const TOPUP_TARGET_FLOOR_WEI = 5_000_000_000_000_000n; // 0.005 ETH — refuse beyond
const TOPUP_RATE_LIMIT_MS = 30_000;
let lastTopupAt = 0;

const TOPUP_ENTRY_POINT_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const TOPUP_PAYMASTER_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
] as const;

app.post('/admin/topup-paymaster', async (c) => {
  // Outer try/catch: any uncaught throw (including unexpected runtime
  // failures from viem helpers) gets reported as JSON, not as a Cloudflare
  // text "Internal Server Error" page. The frontend parses res.json()
  // unconditionally, so we never let it see non-JSON.
  try {
    if (!c.env.DEPLOYER_PRIVATE_KEY) {
      return c.json(
        {
          ok: false,
          error: 'topup_disabled',
          detail: 'DEPLOYER_PRIVATE_KEY is not configured on the worker. Run `wrangler secret put DEPLOYER_PRIVATE_KEY --env production` to enable the one-click topup endpoint.',
        },
        503,
      );
    }
    if (!c.env.PAYMASTER || !c.env.ENTRY_POINT) {
      return c.json(
        { ok: false, error: 'misconfigured', detail: 'PAYMASTER + ENTRY_POINT env required' },
        503,
      );
    }
    if (!c.env.RPC_URL) {
      return c.json(
        { ok: false, error: 'misconfigured', detail: 'RPC_URL env required' },
        503,
      );
    }

    const now = Date.now();
    if (now - lastTopupAt < TOPUP_RATE_LIMIT_MS) {
      const waitSec = Math.ceil((TOPUP_RATE_LIMIT_MS - (now - lastTopupAt)) / 1000);
      return c.json(
        { ok: false, error: 'rate_limited', detail: `wait ${waitSec}s before next topup` },
        429,
      );
    }

    const pub = createPublicClient({ chain: baseSepolia, transport: http(c.env.RPC_URL) });

    let depositBefore: bigint;
    try {
      depositBefore = (await pub.readContract({
        address: c.env.ENTRY_POINT as Address,
        abi: TOPUP_ENTRY_POINT_ABI,
        functionName: 'balanceOf',
        args: [c.env.PAYMASTER as Address],
      })) as bigint;
    } catch (e) {
      return c.json({ ok: false, error: 'read_balance_failed', detail: String(e) }, 500);
    }
    if (depositBefore >= TOPUP_TARGET_FLOOR_WEI) {
      return c.json(
        {
          ok: false,
          error: 'already_funded',
          detail: `paymaster has ${depositBefore.toString()} wei (≥ floor ${TOPUP_TARGET_FLOOR_WEI.toString()}); refusing further topup`,
          depositWei: depositBefore.toString(),
        },
        400,
      );
    }

    // Parse + clamp the requested amount (default 0.002 ETH).
    const body = (await c.req.json().catch(() => ({}))) as { amountEth?: string };
    let amountWei: bigint;
    try {
      amountWei = body.amountEth ? parseEther(String(body.amountEth)) : TOPUP_MAX_WEI;
    } catch {
      return c.json({ ok: false, error: 'bad_amount' }, 400);
    }
    if (amountWei > TOPUP_MAX_WEI) amountWei = TOPUP_MAX_WEI;
    if (amountWei <= 0n) {
      return c.json({ ok: false, error: 'bad_amount', detail: 'amount must be > 0' }, 400);
    }

    // Deployer EOA must have enough ETH + a bit for gas.
    const pkInput = c.env.DEPLOYER_PRIVATE_KEY.startsWith('0x')
      ? (c.env.DEPLOYER_PRIVATE_KEY as `0x${string}`)
      : (`0x${c.env.DEPLOYER_PRIVATE_KEY}` as `0x${string}`);
    const deployerAcct = privateKeyToAccount(pkInput);
    let deployerBal: bigint;
    try {
      deployerBal = await pub.getBalance({ address: deployerAcct.address });
    } catch (e) {
      return c.json({ ok: false, error: 'read_balance_failed', detail: String(e) }, 500);
    }
    const gasReserve = 100_000_000_000_000n; // 0.0001 ETH
    if (deployerBal < amountWei + gasReserve) {
      return c.json(
        {
          ok: false,
          error: 'deployer_underfunded',
          detail: `deployer has ${deployerBal.toString()} wei; needs ${(amountWei + gasReserve).toString()} (amount + gas reserve)`,
          deployerWei: deployerBal.toString(),
        },
        400,
      );
    }

    lastTopupAt = now; // claim the slot BEFORE sending so concurrent calls back off

    let hash: `0x${string}`;
    try {
      const wallet = createWalletClient({ account: deployerAcct, chain: baseSepolia, transport: http(c.env.RPC_URL) });
      hash = await wallet.writeContract({
        address: c.env.PAYMASTER as Address,
        abi: TOPUP_PAYMASTER_ABI,
        functionName: 'deposit',
        args: [],
        value: amountWei,
      });
    } catch (e) {
      lastTopupAt = 0;
      console.error('[demo-a2a] topup write failed:', e);
      return c.json({ ok: false, error: 'topup_send_failed', detail: String(e) }, 500);
    }
    const receipt = await pub.waitForTransactionReceipt({ hash });
    // Poll for the new deposit to propagate — even with the same RPC,
    // balanceOf can lag the tx by a block or two and report stale.
    let depositAfter = depositBefore;
    for (let i = 0; i < 5; i++) {
      depositAfter = (await pub.readContract({
        address: c.env.ENTRY_POINT as Address,
        abi: TOPUP_ENTRY_POINT_ABI,
        functionName: 'balanceOf',
        args: [c.env.PAYMASTER as Address],
      })) as bigint;
      if (depositAfter > depositBefore) break;
      await new Promise((res) => setTimeout(res, 500));
    }

    return c.json({
      ok: true,
      transactionHash: hash,
      status: receipt.status,
      amountWei: amountWei.toString(),
      depositBeforeWei: depositBefore.toString(),
      depositAfterWei: depositAfter.toString(),
    });
  } catch (e) {
    console.error('[demo-a2a] topup-paymaster crashed:', e);
    return c.json(
      { ok: false, error: 'topup_internal_error', detail: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

// ─── STEP 2: session lifecycle ───────────────────────────────────────────

app.post('/session/init', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { accountAddress?: Address } | null;
  if (!body?.accountAddress) return c.json({ error: 'accountAddress required' }, 400);
  try {
    const { sessionId, sessionKeyAddress } = await sessionManagerFor(c.env, body.accountAddress).init(
      body.accountAddress,
      Number(c.env.CHAIN_ID),
    );
    return c.json({ ok: true, sessionId, sessionKeyAddress });
  } catch (e) {
    return c.json({ error: 'session init failed', detail: String(e) }, 500);
  }
});

app.post('/session/package', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    sessionId?: string;
    delegation?: Omit<Delegation, 'salt'> & { salt: string };
    /**
     * Optional. The smart-account address the session was opened under
     * (via `/session/init`). Required when the session holder is the
     * delegate, not the delegator — e.g. Bob's session packaging an
     * Alice→Bob delegation. Defaults to `delegation.delegator` to
     * preserve the original "user packages their own delegation" flow.
     */
    sessionOwner?: Address;
  } | null;
  if (!body?.sessionId || !body.delegation) {
    return c.json({ error: 'sessionId and delegation required' }, 400);
  }
  const delegation: Delegation = { ...body.delegation, salt: BigInt(body.delegation.salt) };
  const eip712Hash = hashDelegation(
    delegation,
    Number(c.env.CHAIN_ID),
    c.env.DELEGATION_MANAGER as Address,
  );
  const isValid = await accountClient(c.env).isValidSignature(
    delegation.delegator,
    eip712Hash,
    delegation.signature,
  );

  // Fail-CLOSED on invalid delegation signature (audit P1-2). The
  // previous behavior persisted regardless of `isValid` and just
  // returned the boolean — that was a state-integrity bug: downstream
  // tool calls would mint tokens against a delegation the contract
  // would have rejected on chain. Reject before persistence.
  if (!isValid) {
    return c.json(
      {
        ok: false,
        error: 'delegation_invalid',
        // Detail intentionally generic (info-leak invariant from
        // mcp-runtime CLAUDE.md). The contract-level reason is logged
        // server-side via the audit sink, not returned to the browser.
        detail: 'ERC-1271 verification failed against the delegator smart account',
      },
      403,
    );
  }

  // Route to the session owner's DO. For the "I delegate to my own
  // agent" flow this is identical to the delegator. For cross-user
  // patterns ("Bob holds Alice's delegation") the caller passes the
  // session holder explicitly so we land on the right shard.
  const owner = body.sessionOwner ?? delegation.delegator;
  try {
    await sessionManagerFor(c.env, owner).package(body.sessionId, delegation);
  } catch (e) {
    return c.json({ error: 'session package failed', detail: String(e) }, 400);
  }

  return c.json({
    ok: true,
    sessionId: body.sessionId,
    delegationHash: eip712Hash,
    erc1271Verified: isValid,
  });
});

// ─── STEP 3: tool proxy ───────────────────────────────────────────────────

app.post('/tools/:name', async (c) => {
  const toolName = c.req.param('name');
  const body = (await c.req.json().catch(() => null)) as {
    sessionId?: string;
    args?: Record<string, unknown>;
  } | null;
  if (!body?.sessionId) return c.json({ error: 'sessionId required' }, 400);

  // /tools/:name is JWT-gated: the user's smart-account address lives in
  // their session cookie. Route to that user's DO.
  const accountAddress = smartAccountFromCookie(c);
  if (!accountAddress) {
    return c.json({ error: 'auth required (missing or invalid session cookie)' }, 401);
  }

  let resolved;
  try {
    resolved = await sessionManagerFor(c.env, accountAddress).resolve(body.sessionId);
  } catch (e) {
    return c.json({ error: 'session resolve failed', detail: String(e) }, 400);
  }
  if (!resolved.delegation) return c.json({ error: 'session has no delegation bound' }, 400);

  const auditSink = buildAuditSink(c.env);
  const correlationId = c.req.header('x-correlation-id') ?? crypto.randomUUID();
  const { token } = await mintDelegationToken(
    {
      iss: 'demo-a2a',
      aud: MCP_AUDIENCE,
      sub: resolved.delegation.delegator,
      delegation: resolved.delegation,
      sessionKeyAddress: resolved.signer.address,
      ttlSeconds: 300,
      usageLimit: 10,
    },
    (msg) => resolved.signer.signMessage(msg),
    { auditSink, correlationId },
  );

  // Build the request body first so we can take its sha256 for the
  // service-MAC envelope (audit C1).
  const requestBody = JSON.stringify({ token, args: body.args ?? {} });

  // Service-MAC envelope. Binds the request to:
  //   audience (MCP server identity), service (a2a-to-mcp), route (tool),
  //   nonce (one-shot replay-tracked at MCP), timestamp (clock-skew bounded),
  //   bodyDigest (sha256 of the JSON body).
  // The MCP server verifies this BEFORE parsing the delegation token —
  // requests without a valid MAC are 401'd before any business logic.
  // Production deploys swap the local-aes MAC provider for a GCP KMS
  // HMAC key via the same `buildMacProvider` factory; no app changes.
  const macProvider = buildMacProvider(MCP_AUDIENCE, {
    backend: 'local-aes',
    config: { sessionSecretHex: c.env.A2A_MAC_SECRET ?? '' },
    auditSink,
  });
  const macHeaders = await generateServiceMac({
    ctx: {
      audience: MCP_AUDIENCE,
      service: 'a2a-to-mcp',
      route: toolName,
      bodyDigest: bodyDigestHex(requestBody),
    },
    provider: macProvider,
  });

  // Worker-to-Worker call: prefer the service binding when available
  // (production — avoids Cloudflare error 1042 on sibling-Worker fetches),
  // fall back to public-URL fetch for local dev where no binding exists.
  const reqInit: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-A2A-Mac': macHeaders.mac,
      'X-A2A-Mac-Nonce': macHeaders.nonce,
      'X-A2A-Mac-Timestamp': macHeaders.timestamp,
      'X-A2A-Mac-Key-Id': macHeaders.keyId,
      'X-Correlation-Id': correlationId,
    },
    body: requestBody,
  };
  const mcpRes = c.env.MCP
    ? await c.env.MCP.fetch(new Request(`https://internal/tools/${toolName}`, reqInit))
    : await fetch(`${c.env.MCP_URL}/tools/${toolName}`, reqInit);
  const mcpBody = (await mcpRes.json().catch(() => ({ error: 'mcp returned non-JSON' }))) as Record<string, unknown>;
  return c.json(mcpBody, mcpRes.ok ? 200 : (mcpRes.status as never));
});

export default app;
