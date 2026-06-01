// demo-a2a as a Cloudflare Worker.
//
// Local dev:  wrangler dev (port 8787; reads .dev.vars for secrets + contract addrs)
// Production: wrangler deploy
//
// State is held in a Durable Object (SessionStoreDO); see ./session-store-do.ts.
// Env bindings come from c.env (typed via the Bindings interface below).

import { Hono, type Context } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import {
  verify as siweVerifyLegacy,
  verifyOnchain as siweVerifyOnchain,
} from '@agenticprimitives/connect-auth/siwe';
import {
  mintSession,
  verifySession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifyUserSignature,
  csrfTokenFor,
  verifyCsrf,
} from '@agenticprimitives/connect-auth';
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
import { baseSepolia } from 'viem/chains';
import {
  AgentAccountClient,
  buildExecuteBatchCallData,
  SaMismatchError,
} from '@agenticprimitives/agent-account';
import { getRelayerAccount, getPaymasterTopupAccount } from './relayer';
import { AgentNamingClient, buildSubregistryRegisterCall, buildSetPrimaryNameCall } from '@agenticprimitives/agent-naming';
import {
  verifyCustodySession,
  deriveSubjectCustodian,
  timingSafeEqual,
  caip10,
} from './custody-google';
import { originAllowed, hostnameAllowed } from './origins';
import { resolveAgentHost, buildA2aAgentCard, AGENT_NAME_PARENT } from './host-context';
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
import { verifyBridgeCall, type NonceStore } from './bridge-hmac';

// SEC-010: in-memory single-use nonce store for the custody-bridge HMAC envelope.
// Bounded by the freshness window — a worker recycle clears the store, which is
// acceptable since the freshness window already bounds replay risk. Production
// deployments should swap this for a KV/D1-backed store for cross-instance defense.
let _bridgeNonces: Map<string, number> | null = null;
function getInMemoryNonceStore(): NonceStore {
  if (!_bridgeNonces) _bridgeNonces = new Map();
  const store = _bridgeNonces;
  return {
    has: async (nonce) => {
      const exp = store.get(nonce);
      if (exp == null) return false;
      if (exp < Date.now()) { store.delete(nonce); return false; }
      return true;
    },
    record: async (nonce, ttlSec) => {
      store.set(nonce, Date.now() + ttlSec * 1000);
      // Opportunistic GC: keep the Map bounded.
      if (store.size > 4096) {
        const now = Date.now();
        for (const [k, exp] of store) if (exp < now) store.delete(k);
      }
    },
  };
}

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
  /**
   * R5.10 / PKG-CONNECT-AUTH-003 — canonical origin of THIS broker.
   * Used as `iss` (and currently `aud`, until spec 227 splits them)
   * when minting session JWTs. Falls back to `https://demo-a2a.local`
   * when unset for the testnet demo path.
   */
  CONNECT_BROKER_ORIGIN?: string;
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
  /** Permissionless `.agent` subregistry (spec 234 W2). When set, /session/register-name
   *  registers a name with owner = the new SA, sponsored by the relayer (no user signature)
   *  — so onboarding's "secure your home" is a single device gesture (the passkey create). */
  PERMISSIONLESS_SUBREGISTRY?: string;
  /** Public registrable base domain for personal A2A endpoints (spec 231).
   *  `<handle>.<A2A_PUBLIC_BASE_DOMAIN>` → agent `<handle>.demo.agent`.
   *  Defaults to `impact-agent.io`. */
  A2A_PUBLIC_BASE_DOMAIN?: string;
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
   * R5.12d — Per-tx cap (in wei) for the paymaster top-up signer.
   * Defaults to 0.002 ETH when unset (matches the route's documented
   * "topup ≤ 0.002 ETH" promise). The cap is enforced BEFORE the HSM
   * round-trip by `createSpendCappedAccount` (R5.12b) so a compromised
   * app process cannot drain the worker beyond this per-tx limit.
   *
   * R5.12d also retired `DEPLOYER_PRIVATE_KEY`. Funded operator ops
   * (direct deploy, register name, custody relay, paymaster top-up)
   * now use `getRelayerAccount(env, role, sink)` / `getPaymasterTopupAccount`,
   * backed by `A2A_KMS_BACKEND` (same env var the UserOp relayer
   * already uses). Testnet: `local-aes` + `A2A_MASTER_PRIVATE_KEY`.
   * Production: `gcp-kms` + a managed KMS resource (no raw key in
   * config).
   */
  PAYMASTER_TOPUP_CAP_WEI?: string;
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

  // ─── Google × KMS custody (spec 235) ────────────────────────────────────
  /** The Connect broker's published JWKS (ES256). The custody gate fetches +
   *  caches this to verify Google custody sessions. e.g.
   *  `https://<broker-origin>/jwks`. Required for /custody/google/{sign,
   *  bootstrap-and-claim}. Fail-closed when unreachable. */
  BROKER_JWKS_URL?: string;
  /** Expected `iss` of broker-minted sessions — the Connect origin. Pinned by
   *  the gate (rejects alien issuers). */
  BROKER_ISS?: string;
  /** Expected `aud` of custody sessions — demo-sso's own client_id (the
   *  Personal Trust Home). Pinned by the gate. */
  DEMO_SSO_AUD?: string;
  /** Shared secret authenticating the broker → /custody/google/resolve
   *  server-to-server call (the broker can't hold the master, so it asks
   *  demo-a2a to derive SA_expected during the OIDC callback). Constant-time
   *  compared; the user's Google authn already happened at the broker. */
  A2A_CUSTODY_BRIDGE_SECRET?: string;
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
  // Patterns may be exact origins OR one wildcard form `https://*.<base>`
  // (spec 231 — per-person subdomains are each a distinct Origin). Match via
  // the shared, fail-closed `originAllowed` (see src/origins.ts).
  const patterns = raw.split(',');
  return (origin) => (origin && originAllowed(origin, patterns) ? origin : '');
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
  // /api/a2a is the machine-to-machine A2A endpoint (spec 231) — no browser
  // cookie/CSRF; authorization is per the A2A protocol, not double-submit.
  if (c.req.path === '/api/a2a') return next();
  // /custody/google/resolve is a server-to-server call from the Connect broker
  // (no browser cookie). It's authenticated by the bridge secret, not CSRF.
  // (bootstrap-and-claim + sign ARE browser-facing and KEEP CSRF.)
  if (c.req.path === '/custody/google/resolve') return next();
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
  // Per-person subdomains (spec 231) are wildcarded in ALLOWED_ORIGINS as
  // `https://*.<base>`. verifyCsrf is exact-match on the token's bound origin,
  // so admit the request's own origin when it matches a wildcard — the HMAC
  // still pins the token to its mint origin, so this can't be forged.
  const reqOrigin = c.req.header('origin');
  if (reqOrigin && originAllowed(reqOrigin, allowed) && !allowed.includes(reqOrigin)) {
    allowed.push(reqOrigin);
  }
  // R5.11 (PKG-CONNECT-AUTH-004 / external audit P1-2) — verifyCsrf
  // now requires `actualOrigin` explicitly. The token's signed origin
  // must equal the inbound Origin header (HMAC tampering would already
  // fail, but this closes the cross-origin replay vector). Demo-a2a's
  // double-submit cookie pattern already rejects requests with no
  // Origin / Referer earlier in the middleware; this is the second
  // gate.
  if (
    !verifyCsrf(headerToken, {
      actualOrigin: reqOrigin ?? '',
      allowedOrigins: allowed,
      // Optional method/path/sessionSid bindings are intentionally not
      // wired here — spec 227 (Real-Connect) will add per-route binding
      // for high-risk endpoints once the route taxonomy is locked.
      developmentMode: true, // testnet demo; spec 227 replaces with real prod gate
    })
  ) {
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
  // R5.11 — csrfTokenFor now takes an opts object. Demo-a2a doesn't
  // bind to method/path/sessionSid yet; spec 227 (Real-Connect) will
  // tighten that for high-risk endpoints.
  const token = csrfTokenFor({ origin: parsedOrigin });
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

// ─── A2A by personal subdomain (spec 231) ─────────────────────────────
// `<handle>.impact-agent.io` is one agent's unified endpoint. demo-sso (Pages)
// owns the subdomain origin and proxies these paths here, injecting
// `X-Agent-Subdomain` (the label) + `X-Public-Origin`. Pattern ported from
// agentic-trust atp-agent (`.well-known/agent-card.json` + `/api/a2a`).

/** A2A AgentCard discovery — agent-bound when a subdomain resolves, else generic. */
async function serveAgentCard(c: Context<{ Bindings: Env }>): Promise<Response> {
  const reqOrigin = new URL(c.req.url).origin;
  const ctx = await resolveAgentHost(c.req.raw, c.env, reqOrigin);
  if (ctx.label && !ctx.agent) {
    return c.json({ error: 'agent_not_found', detail: `no Smart Agent for ${ctx.name}` }, 404);
  }
  return c.json(buildA2aAgentCard(ctx, Number(c.env.CHAIN_ID)));
}
app.get('/.well-known/agent-card.json', serveAgentCard);
app.get('/.well-known/agent.json', serveAgentCard); // legacy alias

/** A2A JSON-RPC message endpoint, scoped to the host's agent. */
app.post('/api/a2a', async (c) => {
  const reqOrigin = new URL(c.req.url).origin;
  const ctx = await resolveAgentHost(c.req.raw, c.env, reqOrigin);
  if (!ctx.label) {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'A2A requests must target a personal subdomain (<handle>.impact-agent.io)' } }, 400);
  }
  if (!ctx.agent) {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32004, message: `no Smart Agent for ${ctx.name}` } }, 404);
  }
  let body: { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
  }
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return c.json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32600, message: 'invalid JSON-RPC request' } }, 400);
  }
  const id = body.id ?? null;
  switch (body.method) {
    case 'message/send':
      // Minimal "live routing" — confirm the message reached the right agent.
      // Skill handling is future work (spec 231 ships discovery + routing).
      return c.json({
        jsonrpc: '2.0',
        id,
        result: {
          agentName: ctx.name,
          agentAddress: ctx.agent,
          status: 'received',
          message: `A2A message routed to ${ctx.name}`,
        },
      });
    default:
      return c.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${body.method}` } }, 404);
  }
});

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
  // R5.10 (PKG-CONNECT-AUTH-003 / external audit P1-1) — connect-auth's
  // verifySession now REQUIRES expectedIss + expectedAud in production
  // and ALSO checks them when supplied in any mode. demo-a2a is the
  // testnet demo broker; the move to a proper iss/aud binding here is
  // tracked separately under the Real-Connect experience work (spec 227 /
  // memory project_real_connect_experience). For now, opt out of the
  // strict gate so the testnet demo keeps booting.
  const claims = verifySession(cookieValue, { developmentMode: true });
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
  const originPatterns = (c.env.ALLOWED_ORIGINS ?? '').split(',');
  for (const origin of originPatterns) {
    const trimmed = origin.trim();
    if (!trimmed || trimmed.includes('*')) continue; // wildcard entries handled below
    try {
      allowedDomains.push(new URL(trimmed).hostname);
    } catch {
      // ignore malformed origin entries
    }
  }
  // Per-person subdomains (spec 231): admit the requesting subdomain's hostname
  // when it matches a `https://*.<base>` wildcard in ALLOWED_ORIGINS.
  const reqHost = (() => {
    try {
      return new URL(c.req.header('origin') ?? c.req.header('referer') ?? '').hostname;
    } catch {
      return '';
    }
  })();
  if (reqHost && hostnameAllowed(reqHost, originPatterns) && !allowedDomains.includes(reqHost)) {
    allowedDomains.push(reqHost);
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
      async ({ signer, hash, signature }) => {
        // R5.12d cleanup: connect-auth's verifyUserSignature returns
        // a typed result `{ok, reason?}` (PKG-CONNECT-AUTH-001 / H7-B.3
        // closure); siweVerifyOnchain's callback expects a boolean.
        // Map the typed result to bool — the SIWE caller's audit row
        // captures the rejection reason separately.
        const r = await verifyUserSignature({
          universalValidator: c.env.UNIVERSAL_SIGNATURE_VALIDATOR as Address,
          signer,
          hash,
          signature,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          client: publicClient as any,
        });
        return r.ok;
      },
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
  // R5.10 (PKG-CONNECT-AUTH-003 / external audit P1-1) — connect-auth's
  // mintSession now requires `iss` (issuer URI) and `aud` (relying app
  // audience id) so verifiers can bind both. For the demo-a2a testnet
  // broker we derive both from the worker's CONNECT_BROKER_ORIGIN env
  // (set in wrangler.toml / dev.vars) and fall back to a clearly-marked
  // demo string when unset. The Real-Connect experience work (spec 227)
  // will replace these with bound origin values.
  const brokerOrigin =
    typeof c.env.CONNECT_BROKER_ORIGIN === 'string' && c.env.CONNECT_BROKER_ORIGIN.length > 0
      ? c.env.CONNECT_BROKER_ORIGIN
      : 'https://demo-a2a.local';
  const cookie = mintSession({
    sub: `did:ethr:${c.env.CHAIN_ID}:${smartAccountAddress}`,
    walletAddress,
    smartAccountAddress,
    name,
    email: null,
    via: 'siwe',
    kind: 'session',
    iss: brokerOrigin,
    aud: brokerOrigin, // same-origin demo; spec 227 will split iss != aud
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
 * sha256 of the host portion of the inbound Origin header. The WebAuthn
 * RP-ID defaults to the registrable host of the calling page when the
 * frontend doesn't set `publicKey.rp.id` explicitly — so the rpIdHash
 * the authenticator binds against is sha256(origin.hostname). Fallback
 * is sha256("impact-agent.me") when origin parsing fails (cross-origin
 * call without an Origin header).
 *
 * H7-C.1 / CON-WEBAUTHN-001: this MUST match the rpIdHash the on-chain
 * AgentAccount stores. The factory stores whatever we pass in
 * initialPasskeyRpIdHash.
 */
async function _deriveRpIdHashFromOrigin(origin: string | undefined): Promise<Hex> {
  let hostname = 'impact-agent.me';
  try {
    if (origin) hostname = new URL(origin).hostname;
  } catch { /* fall through */ }
  const enc = new TextEncoder().encode(hostname);
  const buf = await globalThis.crypto.subtle.digest('SHA-256', enc);
  const arr = Array.from(new Uint8Array(buf));
  return ('0x' + arr.map((b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
}

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
    passkey?: { credentialIdDigest: Hex; pubKeyX: string; pubKeyY: string; rpIdHash?: Hex };
    // Back-compat: legacy fields from the single-method era.
    initMethod?: 'eoa' | 'passkey';
    owner?: Address;
    credentialIdDigest?: Hex;
    pubKeyX?: string;
    pubKeyY?: string;
    rpIdHash?: Hex;
    salt?: string;
    // Optional: calldata the freshly-deployed account executes in the SAME userOp (deploy +
    // execute atomically, e.g. claim its name) — one signature instead of deploy-then-claim.
    callData?: Hex;
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
          // H7-C.1 / CON-WEBAUTHN-001: client supplies rpIdHash (sha256
          // of the WebAuthn RP-ID it registered against). Required by
          // the on-chain factory when a passkey is initialized.
          rpIdHash: body.rpIdHash,
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
              // H7-C.1 / CON-WEBAUTHN-001: on-chain factory rejects a
              // zero rpIdHash when passkey is initialized. Use client-
              // supplied rpIdHash if available; otherwise derive it from
              // the request Origin's hostname (which is what the browser
              // would have used as the WebAuthn RP-ID by default).
              rpIdHash:
                (passkeyInput.rpIdHash as Hex | undefined) ??
                (await _deriveRpIdHashFromOrigin(c.req.header('origin'))),
            }
          : undefined,
        salt,
      },
      callData: body.callData, // deploy + claim in one userOp when supplied
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
  } catch (e: any) {
    // Surface the failure to wrangler tail so production diagnostics
    // don't require client-side DevTools access.
    console.error('[/session/deploy] buildDeployUserOp failed:', String(e), e?.stack);
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
// entirely: the worker uses a KMS-backed relayer
// (`getRelayerAccount(env, 'direct-deploy')`) to directly invoke
// `factory.createAgentAccount(...)`. The factory call is permissionless
// and registers the EOA as a custodian at proxy init. Worker pays gas
// — gasless to the user.
//
// R5.12d / PKG-AGENT-ACCOUNT-005 gate: when the client supplies a
// `smartAccountAddress` in the body, the worker verifies it matches
// the canonical derivation from the validated init params via
// `assertSaMatchesCustodianDerivation` before paying gas.
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
    // R5.12d: the relayer factory throws if the local-aes backend is
    // running in production without an explicit opt-in. No more
    // DEPLOYER_PRIVATE_KEY env check; the KMS path either resolves or
    // fails loudly with an actionable message.
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

    // R5.12d: KMS-backed relayer for funded direct-deploy ops.
    // Replaces privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY).
    const deployer = await getRelayerAccount(c.env, 'direct-deploy', buildAuditSink(c.env));
    const pub = createPublicClient({ chain: baseSepolia, transport: http(c.env.RPC_URL) });
    const wallet = createWalletClient({ account: deployer, chain: baseSepolia, transport: http(c.env.RPC_URL) });

    const predicted = (await pub.readContract({
      address: c.env.AGENT_ACCOUNT_FACTORY as Address,
      abi: DIRECT_DEPLOY_FACTORY_ABI,
      functionName: 'getAddressForAgentAccount',
      args: [params, salt],
    })) as Address;

    // R5.12d / R5.12c gate: verify the CLIENT-SUPPLIED target is the
    // canonical SA derived from the validated init params. The factory
    // view above already derives the address, so by construction the
    // assertion holds for the `predicted` address. But: when the
    // caller-supplied body claims a `smartAccountAddress` field, we
    // MUST verify that matches `predicted` so the relayer never signs
    // a deploy for a target the client invented. Use the new
    // `assertSaMatchesCustodianDerivation` helper.
    if (typeof body.smartAccountAddress === 'string') {
      try {
        const aaClient = new AgentAccountClient({
          rpcUrl: c.env.RPC_URL,
          chainId: Number(c.env.CHAIN_ID),
          entryPoint: c.env.ENTRY_POINT as Address,
          factory: c.env.AGENT_ACCOUNT_FACTORY as Address,
        });
        await aaClient.assertSaMatchesCustodianDerivation({
          claimed: body.smartAccountAddress as Address,
          custodians: params.custodians,
          mode: params.mode,
          salt,
          trustees: params.trustees,
          passkey: params.initialPasskeyX !== 0n || params.initialPasskeyY !== 0n
            ? {
                credentialIdDigest: params.initialPasskeyCredentialIdDigest,
                x: params.initialPasskeyX,
                y: params.initialPasskeyY,
              }
            : undefined,
        });
      } catch (e) {
        if (e instanceof SaMismatchError) {
          return c.json(
            { ok: false, error: 'sa_mismatch', detail: e.message },
            400,
          );
        }
        throw e;
      }
    }

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

// ─── Sponsored name registration (spec 234 W2 — "secure your home" = one gesture) ───
//
// The permissionless subregistry's `register(label, newOwner)` accepts ANY caller and sets
// the child name's owner to `newOwner` (the contract is permissionless by design). So the
// worker registers the just-deployed SA's name from the deployer EOA — no passkey signature.
// This lets onboarding secure a home (deploy + register) with a SINGLE device gesture (the
// WebAuthn create) instead of an extra deploy/claim signature. The relayer is constrained to
// the configured subregistry's `register` only — it can't be used as a general relay.
//
// (Reverse lookup address → name needs the SA to call setPrimaryName itself, which defers to
// the member's first signed action; forward lookup name → SA works immediately via the
// registry's owner fallback. ADR-0013: forward resolution has one mechanism.)
const SUBREGISTRY_REGISTER_ABI = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'label', type: 'string' },
      { name: 'newOwner', type: 'address' },
    ],
    outputs: [{ name: 'node', type: 'bytes32' }],
  },
] as const;

app.post('/session/register-name', async (c) => {
  try {
    if (!c.env.PERMISSIONLESS_SUBREGISTRY) {
      return c.json({ ok: false, error: 'subregistry_missing', detail: 'PERMISSIONLESS_SUBREGISTRY not configured' }, 503);
    }
    const body = (await c.req.json().catch(() => null)) as { label?: unknown; owner?: unknown } | null;
    if (!body) return c.json({ ok: false, error: 'bad_body' }, 400);

    const label = typeof body.label === 'string' ? body.label.toLowerCase() : '';
    const owner = typeof body.owner === 'string' ? body.owner : '';
    if (!/^[a-z0-9-]{1,63}$/.test(label)) return c.json({ ok: false, error: 'bad_label' }, 400);
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) return c.json({ ok: false, error: 'bad_owner' }, 400);

    // R5.12d: KMS-backed relayer for sponsored name registration.
    // PermissionlessSubregistry's `register(label, newOwner)` accepts
    // any caller; the worker only pays gas. The `owner` arg goes to
    // the user's SA, not the relayer, so identity is preserved.
    const deployer = await getRelayerAccount(c.env, 'register-name', buildAuditSink(c.env));
    const pub = createPublicClient({ chain: baseSepolia, transport: http(c.env.RPC_URL) });
    const wallet = createWalletClient({ account: deployer, chain: baseSepolia, transport: http(c.env.RPC_URL) });

    const hash = await wallet.writeContract({
      address: c.env.PERMISSIONLESS_SUBREGISTRY as Address,
      abi: SUBREGISTRY_REGISTER_ABI,
      functionName: 'register',
      args: [label, owner as Address],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    return c.json({ ok: true, transactionHash: hash, status: receipt.status, label });
  } catch (e) {
    console.error('[demo-a2a] register-name failed:', e);
    return c.json({ ok: false, error: 'register_failed', detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// ─── Google × KMS custody (spec 235) — THE GATE lives in ./custody-google.ts ─
//
// Three endpoints let a member whose ONLY credential is Google get + use a
// real Smart Agent. demo-a2a holds the master, so it is the only party that
// can derive the member's per-subject custodian C_sub and sign for their SA.
//
//   resolve            broker → a2a (bridge secret). Derive-only: returns
//                      SA_expected so the broker can mint a custody session
//                      (sub = SA) WITHOUT waiting on-chain. No deploy.
//   bootstrap-and-claim client → a2a (custody session). Deploy SA + claim the
//                      name in one C_sub-signed, paymaster-sponsored userOp.
//   sign               client → a2a (custody session). Sign a userOp /
//                      delegation digest with C_sub (e.g. givePermission).
//
// The SA we act for is always DERIVED from the verified (iss,sub) — never
// client-supplied — and cross-checked against the session's claimed `sub`.

/** Gate config for the client-facing custody endpoints (JWKS + pinned iss/aud). */
function custodyGateConfig(env: Env): { jwksUrl: string; expectedIss: string; expectedAud: string } | null {
  if (!env.BROKER_JWKS_URL || !env.BROKER_ISS || !env.DEMO_SSO_AUD) return null;
  return { jwksUrl: env.BROKER_JWKS_URL, expectedIss: env.BROKER_ISS, expectedAud: env.DEMO_SSO_AUD };
}

/**
 * POST /custody/google/resolve  (broker → a2a, bridge-secret authenticated)
 * Body: { iss, sub }  → { ok, agent, agentId (CAIP-10), custodian }
 *
 * Derive-only: the OIDC callback can't hold the master, so it asks demo-a2a
 * for SA_expected to mint a custody session + record the facet. No on-chain
 * effect — fast. Authenticated by the shared bridge secret (the user's Google
 * authn already happened at the broker).
 */
app.post('/custody/google/resolve', async (c) => {
  const secret = c.env.A2A_CUSTODY_BRIDGE_SECRET;
  if (!secret) return c.json({ ok: false, error: 'custody_bridge_not_configured' }, 503);

  // SEC-010: verify HMAC envelope. Replaces the bearer-secret authn so a
  // compromise yields short-window replay only — bounded by freshness + nonce.
  const rawBody = await c.req.text();
  const ev = await verifyBridgeCall({
    request: c.req.raw,
    rawBody,
    secret,
    expectedAudience: 'custody.google.resolve',
    nonces: getInMemoryNonceStore(),
  });
  if (!ev.ok) return c.json({ ok: false, error: `unauthorized: ${ev.reason}` }, 401);

  const body = (() => { try { return JSON.parse(rawBody); } catch { return null; } })() as { iss?: string; sub?: string; rotation?: number } | null;
  if (!body?.iss || !body?.sub) return c.json({ ok: false, error: 'iss + sub required' }, 400);
  const rotation = typeof body.rotation === 'number' && body.rotation >= 0 ? body.rotation : 0;
  try {
    const { cSub } = await deriveSubjectCustodian({ iss: body.iss, sub: body.sub }, c.env.A2A_MASTER_PRIVATE_KEY, { rotation });
    const agent = await accountClient(c.env).getAddressForAgentAccount({ custodians: [cSub], salt: 0n });
    return c.json({ ok: true, agent, agentId: caip10(Number(c.env.CHAIN_ID), agent), custodian: cSub });
  } catch (e) {
    console.error('[demo-a2a] custody/google/resolve failed:', e);
    return c.json({ ok: false, error: 'resolve_failed', detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/**
 * POST /custody/google/bootstrap-and-claim  (client → a2a, custody session)
 * Body: { session, label, node }  → { ok, agent, agentId, name, transactionHash }
 *
 * Deploy SA_expected (custodians:[C_sub], salt 0) + claim `<label>` +
 * setPrimary(node) in ONE C_sub-signed, paymaster-sponsored userOp. The
 * member's only gesture was signing in with Google.
 */
app.post('/custody/google/bootstrap-and-claim', async (c) => {
  if (!c.env.PAYMASTER) return c.json({ ok: false, error: 'paymaster not configured' }, 409);
  if (!c.env.PERMISSIONLESS_SUBREGISTRY || !c.env.AGENT_NAME_REGISTRY) {
    return c.json({ ok: false, error: 'naming_not_configured' }, 503);
  }
  const gateCfg = custodyGateConfig(c.env);
  if (!gateCfg) return c.json({ ok: false, error: 'custody_gate_not_configured' }, 503);

  const body = (await c.req.json().catch(() => null)) as { session?: string; label?: string; node?: Hex } | null;
  if (!body?.session || !body?.label || !body?.node) {
    return c.json({ ok: false, error: 'session + label + node required' }, 400);
  }
  const label = body.label.toLowerCase();
  if (!/^[a-z0-9-]{1,63}$/.test(label)) return c.json({ ok: false, error: 'bad_label' }, 400);
  if (!/^0x[0-9a-fA-F]{64}$/.test(body.node)) return c.json({ ok: false, error: 'bad_node' }, 400);

  const gate = await verifyCustodySession(body.session, gateCfg);
  if (!gate.ok) return c.json({ ok: false, error: gate.error }, gate.status as 400);

  try {
    const { cSub, sign } = await deriveSubjectCustodian(gate.subject, c.env.A2A_MASTER_PRIVATE_KEY, {
      auditSink: buildAuditSink(c.env), // G-2: C_sub signatures emit key-custody.sign
      rotation: gate.rotation, // spec 235 §5b: derive the rotation the broker minted
    });
    const sa = await accountClient(c.env).getAddressForAgentAccount({ custodians: [cSub], salt: 0n });
    // INVARIANT (spec 235 §5.4): act ONLY for the SA the session proves.
    if (gate.sessionSub.toLowerCase() !== caip10(Number(c.env.CHAIN_ID), sa).toLowerCase()) {
      return c.json({ ok: false, error: 'sa_mismatch', detail: 'session subject ≠ derived SA' }, 403);
    }

    // Idempotent: if already deployed, the atomic deploy+claim already ran.
    const pub = createPublicClient({ chain: baseSepolia, transport: http(c.env.RPC_URL) });
    const code = await pub.getBytecode({ address: sa });
    if (code && code !== '0x') {
      return c.json({ ok: true, agent: sa, agentId: caip10(Number(c.env.CHAIN_ID), sa), name: `${label}.${AGENT_NAME_PARENT}`, alreadyDeployed: true });
    }

    const register = buildSubregistryRegisterCall({
      subregistry: c.env.PERMISSIONLESS_SUBREGISTRY as Address,
      label,
      newOwner: sa,
    });
    const setPrimary = buildSetPrimaryNameCall({ registry: c.env.AGENT_NAME_REGISTRY as Address, node: body.node });
    const callData = buildExecuteBatchCallData([register, setPrimary]);

    let verifyingPaymaster: { signFn: (hash: Hex) => Promise<Hex> } | undefined;
    if (c.env.PAYMASTER_VERIFYING_SIGNER) {
      const backend = ((process.env.A2A_KMS_BACKEND as KmsBackend | undefined) || 'local-aes');
      const kmsAccount = await createKmsViemAccount(buildSignerBackend({ backend, auditSink: buildAuditSink(c.env) }));
      verifyingPaymaster = { signFn: async (hash) => (await kmsAccount.signMessage({ message: { raw: hash } })) as Hex };
    }

    const { userOp, userOpHash, sender } = await accountClient(c.env).buildDeployUserOpForAgentAccount({
      spec: { custodians: [cSub], salt: 0n },
      callData,
      paymaster: c.env.PAYMASTER as Address,
      verifyingPaymaster,
    });
    if (sender.toLowerCase() !== sa.toLowerCase()) {
      return c.json({ ok: false, error: 'sender_mismatch', detail: 'built userOp sender ≠ derived SA' }, 500);
    }

    // C_sub signs the userOpHash (65-byte ECDSA — AgentAccount._verifyEcdsa accepts it).
    const signature = await sign(userOpHash);
    const backend = ((process.env.A2A_KMS_BACKEND as KmsBackend | undefined) || 'local-aes');
    const relayerAccount = await createKmsViemAccount(buildSignerBackend({ backend, auditSink: buildAuditSink(c.env) }));
    const { deployedAddress, receipt } = await accountClient(c.env).submitDeployUserOp({ ...userOp, signature }, relayerAccount);
    const inner = detectInnerOpFailure(receipt as unknown as Parameters<typeof detectInnerOpFailure>[0]);
    if (!inner.ok) {
      return c.json(
        {
          ok: false,
          error: 'userop_reverted',
          detail: inner.revertReason ? `inner userOp reverted with ${inner.revertReason}` : 'inner userOp reverted',
          transactionHash: receipt.transactionHash,
        },
        500,
      );
    }
    return c.json({
      ok: true,
      agent: deployedAddress ?? sa,
      agentId: caip10(Number(c.env.CHAIN_ID), sa),
      name: `${label}.${AGENT_NAME_PARENT}`,
      transactionHash: receipt.transactionHash,
    });
  } catch (e) {
    console.error('[demo-a2a] custody/google/bootstrap-and-claim failed:', e);
    return c.json({ ok: false, error: 'bootstrap_failed', detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/**
 * POST /custody/google/sign  (client → a2a, custody session)
 * Body: { session, hash, sender }  → { ok, signature, custodian }
 *
 * Sign a 32-byte userOp / delegation digest with C_sub — for post-onboarding
 * actions (e.g. givePermission's EIP-712 delegation, future userOps), with no
 * device gesture. Only ever signs for the SA the session proves.
 */
app.post('/custody/google/sign', async (c) => {
  const gateCfg = custodyGateConfig(c.env);
  if (!gateCfg) return c.json({ ok: false, error: 'custody_gate_not_configured' }, 503);

  const body = (await c.req.json().catch(() => null)) as { session?: string; hash?: Hex; sender?: Address } | null;
  if (!body?.session || !body?.hash || !body?.sender) {
    return c.json({ ok: false, error: 'session + hash + sender required' }, 400);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(body.hash)) return c.json({ ok: false, error: 'bad_hash (need 32-byte digest)' }, 400);
  if (!/^0x[0-9a-fA-F]{40}$/.test(body.sender)) return c.json({ ok: false, error: 'bad_sender' }, 400);

  const gate = await verifyCustodySession(body.session, gateCfg);
  if (!gate.ok) return c.json({ ok: false, error: gate.error }, gate.status as 400);

  try {
    const { cSub, sign } = await deriveSubjectCustodian(gate.subject, c.env.A2A_MASTER_PRIVATE_KEY, {
      auditSink: buildAuditSink(c.env), // G-2: C_sub signatures emit key-custody.sign
      rotation: gate.rotation, // spec 235 §5b: derive the rotation the broker minted
    });
    const sa = await accountClient(c.env).getAddressForAgentAccount({ custodians: [cSub], salt: 0n });
    // INVARIANT (spec 235 §5.4): only sign for the SA the session proves.
    if ((body.sender as string).toLowerCase() !== sa.toLowerCase()) {
      return c.json({ ok: false, error: 'sender_mismatch', detail: 'requested sender ≠ session SA' }, 403);
    }
    if (gate.sessionSub.toLowerCase() !== caip10(Number(c.env.CHAIN_ID), sa).toLowerCase()) {
      return c.json({ ok: false, error: 'sa_mismatch' }, 403);
    }
    const signature = await sign(body.hash);
    return c.json({ ok: true, signature, custodian: cSub });
  } catch (e) {
    console.error('[demo-a2a] custody/google/sign failed:', e);
    return c.json({ ok: false, error: 'sign_failed', detail: e instanceof Error ? e.message : String(e) }, 500);
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

// R5.12d: KMS-backed relayer for custody-policy gas sponsorship. The
// custody-policy contract validates the quorum sigs over an EIP-712
// hash; it does NOT constrain msg.sender. The relayer here is paying
// gas only — identity rests on the quorum sigs in the calldata.
async function relayDeployer(env: Env, sink: AuditSink) {
  return getRelayerAccount(env, 'custody-relay', sink);
}

app.post('/session/custody-schedule', async (c) => {
  try {
    const deployer = await relayDeployer(c.env, buildAuditSink(c.env));
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
    const deployer = await relayDeployer(c.env, buildAuditSink(c.env));
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
  // Use the CANONICAL delegation hash (packages/delegation hashDelegation) — it matches the
  // on-chain DelegationManager CAVEAT_TYPEHASH, which EXCLUDES `args` from the signed hash
  // (audit F-1). The previous inline hashTypedData here wrongly included `args` in the Caveat
  // type, so it computed a different digest than what any correct signer produces → every
  // valid delegation was rejected with 0xffffffff.
  const digest = hashDelegation(
    {
      delegator: delegation.delegator,
      delegate: delegation.delegate,
      authority: delegation.authority,
      caveats: delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })),
      salt: BigInt(delegation.salt),
      signature: delegation.signature,
    },
    Number(env.CHAIN_ID ?? 84532),
    env.DELEGATION_MANAGER as Address,
  );
  try {
    const magic = (await pub.readContract({
      address: delegation.delegator,
      abi: ERC1271_ABI,
      functionName: 'isValidSignature',
      args: [digest, delegation.signature],
    })) as Hex;
    if (magic.toLowerCase() !== ERC1271_MAGIC) {
      // Diagnostics: parse the WebAuthn assertion to compare what the SA
      // STORES vs. what the signature CARRIES (rpIdHash, credentialIdDigest,
      // pubkey).
      try {
        const sig = delegation.signature as Hex;
        const tag = sig.slice(0, 4); // '0x01'
        let credIdDigest: Hex | null = null;
        let assertionRpIdHash: Hex | null = null;
        if (tag === '0x01') {
          try {
            const { decodeAbiParameters } = await import('viem');
            const tail = ('0x' + sig.slice(4)) as Hex;
            const decoded = decodeAbiParameters(
              [
                {
                  type: 'tuple',
                  components: [
                    { name: 'authenticatorData', type: 'bytes' },
                    { name: 'clientDataJSON', type: 'string' },
                    { name: 'challengeIndex', type: 'uint256' },
                    { name: 'typeIndex', type: 'uint256' },
                    { name: 'r', type: 'uint256' },
                    { name: 's', type: 'uint256' },
                    { name: 'credentialIdDigest', type: 'bytes32' },
                  ],
                },
              ],
              tail,
            ) as unknown as [{ authenticatorData: Hex; credentialIdDigest: Hex }];
            credIdDigest = decoded[0].credentialIdDigest;
            // rpIdHash is the FIRST 32 bytes of authenticatorData.
            const ad = decoded[0].authenticatorData;
            assertionRpIdHash = ('0x' + ad.slice(2, 2 + 64)) as Hex;
          } catch (parseErr) {
            console.error('[verifyDelegation] could not parse assertion:', String(parseErr));
          }
        }
        // What the SA stores for that credential.
        let saHasPasskey: boolean | null = null;
        let saStoredX: bigint | null = null;
        let saStoredY: bigint | null = null;
        let saRpIdHash: Hex | null = null;
        if (credIdDigest) {
          try {
            saHasPasskey = (await pub.readContract({
              address: delegation.delegator,
              abi: [
                { name: 'hasPasskey', type: 'function', stateMutability: 'view', inputs: [{ name: 'd', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
              ] as const,
              functionName: 'hasPasskey',
              args: [credIdDigest],
            })) as boolean;
            if (saHasPasskey) {
              const [x, y] = (await pub.readContract({
                address: delegation.delegator,
                abi: [
                  { name: 'getPasskey', type: 'function', stateMutability: 'view', inputs: [{ name: 'd', type: 'bytes32' }], outputs: [{ name: 'x', type: 'uint256' }, { name: 'y', type: 'uint256' }] },
                ] as const,
                functionName: 'getPasskey',
                args: [credIdDigest],
              })) as readonly [bigint, bigint];
              saStoredX = x;
              saStoredY = y;
            }
            // rpIdHashOf is an internal mapping; read its slot directly.
            // PasskeyStorage uses ERC-7201 namespaced storage. Hard to compute
            // off-the-cuff — skip slot read; we'll diagnose by event log or
            // a future view function.
          } catch (saErr) {
            console.error('[verifyDelegation] SA view failed:', String(saErr));
          }
        }
        const code = await pub.getBytecode({ address: delegation.delegator });
        const hasCode = code != null && code !== '0x';
        console.error(
          `[verifyDelegation] ERC-1271 mismatch:`,
          JSON.stringify({
            delegator: delegation.delegator,
            hasCode,
            digest,
            sigLen: delegation.signature?.length,
            sigTag: tag,
            credIdDigest,
            assertionRpIdHash,
            saHasPasskey,
            saStoredX: saStoredX?.toString(),
            saStoredY: saStoredY?.toString(),
            saRpIdHash,
            magicReturned: magic,
          }),
        );
      } catch (diagErr) {
        console.error('[verifyDelegation] diag failed:', String(diagErr));
      }
      return { ok: false, reason: `ERC-1271 returned ${magic} (expected ${ERC1271_MAGIC})` };
    }
    return { ok: true };
  } catch (e) {
    console.error('[verifyDelegation] ERC-1271 call threw:', delegation.delegator, String(e));
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
// One-click "send ETH from the KMS-backed top-up signer to the paymaster's
// EntryPoint deposit." Used by the demo's top-bar gas readout: when the
// paymaster runs low, clicking the ⛽ pill calls this endpoint instead of
// forcing the operator to shell into the deploy env to run `cast send`.
//
// R5.12d defence-in-depth:
//   - Per-call ≤ TOPUP_MAX_WEI (0.002 ETH).
//   - The signer itself is wrapped in `createSpendCappedAccount` via
//     `getPaymasterTopupAccount`, so a tx with `value > PAYMASTER_TOPUP_CAP_WEI`
//     throws BEFORE the HSM round-trip even if the app-layer cap is bypassed.
//   - Refuses topup when paymaster.balanceOf(EntryPoint) is already
//     ≥ 0.005 ETH (TOPUP_TARGET_FLOOR — leaves plenty of headroom
//     before the next refill).
//   - At most 1 topup per 30s per worker isolate (lastTopupAt).
//   - CSRF-protected (the global middleware enforces).

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

    // R5.12d: KMS-backed top-up signer, wrapped in createSpendCappedAccount.
    // The cap is enforced BEFORE the HSM round-trip (R5.12b), so even
    // if the app-layer TOPUP_MAX_WEI clamp is somehow bypassed, the
    // signer wrapper itself refuses any tx beyond the cap.
    const deployerAcct = await getPaymasterTopupAccount(c.env, buildAuditSink(c.env));
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
