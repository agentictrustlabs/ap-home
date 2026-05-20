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
  verify as siweVerify,
  type SiweVerifyResult,
} from '@agenticprimitives/identity-auth/siwe';
import {
  mintSession,
  verifySession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from '@agenticprimitives/identity-auth';
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

  // Contract addresses (.dev.vars locally; wrangler secret put for production)
  ENTRY_POINT: string;
  DELEGATION_MANAGER: string;
  AGENT_ACCOUNT_FACTORY: string;
  TIMESTAMP_ENFORCER: string;
  ALLOWED_TARGETS_ENFORCER: string;
  ALLOWED_METHODS_ENFORCER: string;
  VALUE_ENFORCER: string;
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
  }),
);

// Temporary diagnostic — returns key env values so we can spot misconfig
// without redeploying. Remove before any public release.
app.get('/debug/env', (c) =>
  c.json({
    MCP_URL: c.env.MCP_URL,
    MCP_URL_length: c.env.MCP_URL?.length,
    ALLOWED_ORIGINS: c.env.ALLOWED_ORIGINS,
    A2A_KMS_BACKEND: process.env.A2A_KMS_BACKEND,
    HAS_GCP_ENCRYPT_KEY: !!c.env.GCP_KMS_ENCRYPT_KEY_NAME,
  }),
);

// Temporary diagnostic — replays the demo-a2a → demo-mcp call shape and
// reports what comes back. Helps diagnose worker-to-worker fetch quirks.
app.get('/debug/mcp-roundtrip', async (c) => {
  const url = `${c.env.MCP_URL}/tools/get_profile`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'fake', args: {} }),
    });
    const text = await res.text();
    return c.json({
      url,
      status: res.status,
      contentType: res.headers.get('content-type'),
      bodyPreview: text.slice(0, 200),
      bodyLength: text.length,
    });
  } catch (e) {
    return c.json({ url, error: e instanceof Error ? e.message : String(e) }, 500);
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
  } | null;
  if (!body || typeof body.message !== 'string' || typeof body.signature !== 'string') {
    return c.json({ error: 'message and signature required' }, 400);
  }

  // Allowed SIWE domains: local dev + any hostname extracted from
  // ALLOWED_ORIGINS (which is the deployed Pages URL in production).
  // The frontend's SIWE message uses `window.location.hostname`, so the
  // hostnames here must match whatever origin a legitimate user is on.
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
  const result: SiweVerifyResult | { ok: false; reason: string } = siweVerify(
    body.message,
    body.signature,
    { allowedDomains },
  );
  if (!result.ok) {
    return c.json({ error: 'siwe verify failed', reason: result.reason }, 401);
  }

  const walletAddress = result.address;
  let smartAccountAddress: Address;
  try {
    smartAccountAddress = await accountClient(c.env).getAddress(walletAddress, 0n);
  } catch (e) {
    return c.json({ error: 'smart-account-address derivation failed', detail: String(e) }, 500);
  }

  const isDeployed = await accountClient(c.env).isDeployed(smartAccountAddress).catch(() => false);
  // No backend-driven deploy here. Step 1.5 in the frontend handles deploy
  // via paymaster-sponsored UserOp (user signs the userOpHash, demo-a2a
  // bundles + submits through the EntryPoint). That's the canonical
  // deployment path; this endpoint just reports whether the account is
  // already on-chain.

  const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : 'Demo User';
  const cookie = mintSession({
    sub: `did:ethr:${c.env.CHAIN_ID}:${walletAddress}`,
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
 * Body: { owner: Address, salt?: string }
 * Returns: { userOp, userOpHash, sender } — for the client to sign userOpHash
 *
 * No-op (returns 409) if PAYMASTER env is unset, since we have no paymaster
 * to route the UserOp through.
 */
app.post('/session/deploy', async (c) => {
  if (!c.env.PAYMASTER) {
    return c.json({ error: 'paymaster not configured', detail: 'set PAYMASTER env to enable lazy deploy' }, 409);
  }
  const body = (await c.req.json().catch(() => null)) as { owner?: Address; salt?: string } | null;
  if (!body?.owner) return c.json({ error: 'owner required' }, 400);
  const salt = body.salt ? BigInt(body.salt) : 0n;
  try {
    const { userOp, userOpHash, sender } = await accountClient(c.env).buildDeployUserOp({
      owner: body.owner,
      salt,
      paymaster: c.env.PAYMASTER as Address,
    });
    // Serialize bigints to strings for JSON.
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

  const mcpRes = await fetch(`${c.env.MCP_URL}/tools/${toolName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, args: body.args ?? {} }),
  });
  const mcpBody = (await mcpRes.json().catch(() => ({ error: 'mcp returned non-JSON' }))) as Record<string, unknown>;
  return c.json(mcpBody, mcpRes.ok ? 200 : (mcpRes.status as never));
});

export default app;
