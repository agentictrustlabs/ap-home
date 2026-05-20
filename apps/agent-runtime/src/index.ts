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
import { createPublicClient, http } from 'viem';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { buildKeyProvider, buildSignerBackend, type KmsBackend } from '@agenticprimitives/key-custody';
import { createKmsViemAccount } from '@agenticprimitives/key-custody/kms-viem';
import {
  SessionManager,
  hashDelegation,
  mintDelegationToken,
  type Delegation,
} from '@agenticprimitives/delegation';
import type { Address, Hex } from '@agenticprimitives/types';
import { SessionStoreDO, DurableObjectSessionStore } from './session-store-do';

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

  // Secrets (.dev.vars / wrangler secret put)
  SESSION_JWT_SECRETS: string;
  CSRF_SECRET: string;
  A2A_SESSION_SECRET: string;
  A2A_MASTER_PRIVATE_KEY: string;
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

const app = new Hono<{ Bindings: Env }>();

app.use(
  '*',
  cors({
    origin: (origin) => origin ?? '*',
    credentials: true,
  }),
);

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
  setCookie(c, CSRF_COOKIE, token, {
    httpOnly: false, // JS reads this and echoes as X-CSRF-Token
    sameSite: 'Lax',
    secure: parsedOrigin.startsWith('https://'),
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
    // Note: RPC_URL is intentionally NOT exposed. When it embeds an
    // API key (Alchemy / Infura / etc.), the public /deployments
    // endpoint would leak it. The browser instead calls
    // /account/derive-address for any view-call address derivation.
  }),
);

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
      smartAccountAddress = await accountClient(c.env).getAddressForPasskey(
        body.credentialIdDigest as Hex,
        x,
        y,
        salt,
      );
    } else {
      if (typeof body.owner !== 'string' || !ADDRESS_REGEX.test(body.owner)) {
        return c.json({ error: 'owner must be a 0x-prefixed 20-byte hex address' }, 400);
      }
      smartAccountAddress = await accountClient(c.env).getAddress(body.owner, salt);
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
  const backend = ((process.env.A2A_KMS_BACKEND as KmsBackend | undefined) ?? 'local-aes') as KmsBackend;
  try {
    const signer = buildSignerBackend({ backend });
    const address = await signer.getSignerAddress();
    return c.json({ backend, address });
  } catch (err) {
    return c.json(
      { backend, error: err instanceof Error ? err.message : String(err) },
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
  const backend = (process.env.A2A_KMS_BACKEND as KmsBackend | undefined) ?? 'local-aes';
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
      smartAccountAddress = await accountClient(c.env).getAddress(walletAddress, 0n);
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
    initMethod?: 'eoa' | 'passkey';
    owner?: Address;
    credentialIdDigest?: Hex;
    pubKeyX?: string;
    pubKeyY?: string;
    salt?: string;
  } | null;
  if (!body) return c.json({ error: 'body required' }, 400);
  const salt = body.salt ? BigInt(body.salt) : 0n;
  const initMethod = body.initMethod ?? 'eoa';

  try {
    let userOp, userOpHash, sender;
    if (initMethod === 'passkey') {
      if (!body.credentialIdDigest || !body.pubKeyX || !body.pubKeyY) {
        return c.json(
          { error: 'credentialIdDigest, pubKeyX, pubKeyY required for initMethod=passkey' },
          400,
        );
      }
      ({ userOp, userOpHash, sender } = await accountClient(c.env).buildDeployUserOpWithPasskey({
        credentialIdDigest: body.credentialIdDigest,
        pubKeyX: BigInt(body.pubKeyX),
        pubKeyY: BigInt(body.pubKeyY),
        salt,
        paymaster: c.env.PAYMASTER as Address,
      }));
    } else {
      if (!body.owner) return c.json({ error: 'owner required for initMethod=eoa' }, 400);
      ({ userOp, userOpHash, sender } = await accountClient(c.env).buildDeployUserOp({
        owner: body.owner,
        salt,
        paymaster: c.env.PAYMASTER as Address,
      }));
    }
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
    const backend = (process.env.A2A_KMS_BACKEND as KmsBackend | undefined) ?? 'local-aes';
    const kmsBackend = buildSignerBackend({ backend });
    const relayerAccount = await createKmsViemAccount(kmsBackend);
    const { deployedAddress, receipt } = await accountClient(c.env).submitDeployUserOp(
      signedUserOp,
      relayerAccount,
    );
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

  // delegation.delegator IS the smart-account address — use it to route to
  // the correct per-user DO.
  try {
    await sessionManagerFor(c.env, delegation.delegator).package(body.sessionId, delegation);
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
  );

  // Worker-to-Worker call: prefer the service binding when available
  // (production — avoids Cloudflare error 1042 on sibling-Worker fetches),
  // fall back to public-URL fetch for local dev where no binding exists.
  const reqInit: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, args: body.args ?? {} }),
  };
  const mcpRes = c.env.MCP
    ? await c.env.MCP.fetch(new Request(`https://internal/tools/${toolName}`, reqInit))
    : await fetch(`${c.env.MCP_URL}/tools/${toolName}`, reqInit);
  const mcpBody = (await mcpRes.json().catch(() => ({ error: 'mcp returned non-JSON' }))) as Record<string, unknown>;
  return c.json(mcpBody, mcpRes.ok ? 200 : (mcpRes.status as never));
});

export default app;
