// demo-a2a as a Cloudflare Worker.
//
// Local dev:  wrangler dev (port 8787; reads .dev.vars for secrets + contract addrs)
// Production: wrangler deploy
//
// State is held in a Durable Object (SessionStoreDO); see ./session-store-do.ts.
// Env bindings come from c.env (typed via the Bindings interface below).

import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import {
  verify as siweVerify,
  type SiweVerifyResult,
} from '@agenticprimitives/identity-auth/siwe';
import {
  mintSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from '@agenticprimitives/identity-auth';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { buildKeyProvider, buildSignerBackend, type KmsBackend } from '@agenticprimitives/key-custody';
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

  // Secrets (.dev.vars / wrangler secret put)
  SESSION_JWT_SECRETS: string;
  CSRF_SECRET: string;
  A2A_SESSION_SECRET: string;
  A2A_MASTER_PRIVATE_KEY: string;
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

function sessionManagerFor(env: Env): SessionManager {
  const keyCustody = buildKeyProvider({ backend: 'local-aes' });
  const store = new DurableObjectSessionStore(env.SESSIONS);
  return new SessionManager({ keyCustody, store });
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

  const result: SiweVerifyResult | { ok: false; reason: string } = siweVerify(
    body.message,
    body.signature,
    { allowedDomains: ['demo.agenticprimitives.local', '127.0.0.1', 'localhost'] },
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

// ─── STEP 2: session lifecycle ───────────────────────────────────────────

app.post('/session/init', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { accountAddress?: Address } | null;
  if (!body?.accountAddress) return c.json({ error: 'accountAddress required' }, 400);
  try {
    const { sessionId, sessionKeyAddress } = await sessionManagerFor(c.env).init(
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

  try {
    await sessionManagerFor(c.env).package(body.sessionId, delegation);
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

  let resolved;
  try {
    resolved = await sessionManagerFor(c.env).resolve(body.sessionId);
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
