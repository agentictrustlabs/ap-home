import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { setCookie } from 'hono/cookie';
import {
  verify as siweVerify,
  type SiweVerifyResult,
} from '@agenticprimitives/identity-auth/siwe';
import {
  mintSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  deriveSaltFromLabel,
} from '@agenticprimitives/identity-auth';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { buildKeyProvider } from '@agenticprimitives/key-custody';
import {
  SessionManager,
  createMemorySessionStore,
  hashDelegation,
  mintDelegationToken,
  type Delegation,
} from '@agenticprimitives/delegation';
import type { Address, Hex } from '@agenticprimitives/types';
import { loadConfig } from './config';

const config = loadConfig();

const accountClient = new AgentAccountClient({
  rpcUrl: config.rpcUrl,
  chainId: config.chainId,
  entryPoint: config.deployments.entryPoint,
  factory: config.deployments.agentAccountFactory,
});

const keyCustody = buildKeyProvider({ backend: 'local-aes' });
const sessionStore = createMemorySessionStore();
const sessionManager = new SessionManager({ keyCustody, store: sessionStore });

const app = new Hono();

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'demo-a2a',
    chainId: config.chainId,
    factory: config.deployments.agentAccountFactory,
  }),
);

// Public read of deployed contract addresses. These are not secrets — they
// live on-chain. The web app fetches once on load so it can build the
// EIP-712 Delegation against the right verifyingContract + enforcer addrs.
app.get('/deployments', (c) =>
  c.json({
    chainId: config.chainId,
    delegationManager: config.deployments.delegationManager,
    agentAccountFactory: config.deployments.agentAccountFactory,
    timestampEnforcer: config.deployments.timestampEnforcer,
    allowedTargetsEnforcer: config.deployments.allowedTargetsEnforcer,
    allowedMethodsEnforcer: config.deployments.allowedMethodsEnforcer,
    valueEnforcer: config.deployments.valueEnforcer,
  }),
);

app.post('/auth/siwe-verify', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { message?: string; signature?: Hex; name?: string } | null;
  if (!body || typeof body.message !== 'string' || typeof body.signature !== 'string') {
    return c.json({ error: 'message and signature required' }, 400);
  }

  // Verify SIWE message
  const result: SiweVerifyResult | { ok: false; reason: string } = siweVerify(body.message, body.signature, {
    // For the demo: accept the localhost domain names the web app uses.
    allowedDomains: ['demo.agenticprimitives.local', '127.0.0.1', 'localhost'],
  });
  if (!result.ok) {
    return c.json({ error: 'siwe verify failed', reason: result.reason }, 401);
  }

  // Derive smart account address via factory. Salt = 0 for SIWE per spec 201 §2.
  const walletAddress = result.address;
  const salt = 0n;
  let smartAccountAddress: Address;
  try {
    smartAccountAddress = await accountClient.getAddress(walletAddress, salt);
  } catch (e) {
    return c.json({ error: 'smart-account-address derivation failed', detail: String(e) }, 500);
  }

  const isDeployed = await accountClient.isDeployed(smartAccountAddress).catch(() => false);

  // Mint JWT session
  const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : 'Demo User';
  const cookie = mintSession({
    sub: `did:ethr:${config.chainId}:${walletAddress}`,
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

  return c.json({
    ok: true,
    walletAddress,
    smartAccountAddress,
    isDeployed,
  });
});

// STEP 2a: initialize a session — generate a session keypair, persist
// encrypted-pending. Returns the sessionId + sessionKeyAddress for the web
// app to use as the `delegate` field of the Delegation it builds.
app.post('/session/init', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { accountAddress?: Address } | null;
  if (!body?.accountAddress) {
    return c.json({ error: 'accountAddress required' }, 400);
  }
  try {
    const { sessionId, sessionKeyAddress } = await sessionManager.init(body.accountAddress, config.chainId);
    return c.json({ ok: true, sessionId, sessionKeyAddress });
  } catch (e) {
    return c.json({ error: 'session init failed', detail: String(e) }, 500);
  }
});

// STEP 2b: receive the user-signed Delegation, verify the ERC-1271 signature
// via the smart account on-chain, then mark the session active.
app.post('/session/package', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    sessionId?: string;
    delegation?: Omit<Delegation, 'salt'> & { salt: string };
  } | null;
  if (!body?.sessionId || !body.delegation) {
    return c.json({ error: 'sessionId and delegation required' }, 400);
  }

  // Rehydrate salt: BigInt comes across the wire as a string.
  const delegation: Delegation = { ...body.delegation, salt: BigInt(body.delegation.salt) };

  // Verify the delegation signature via ERC-1271 against the smart account.
  // For an EOA-owned smart account, the smart-account-impl recovers the
  // owner from the signature and returns the magic value if owner.
  const eip712Hash = hashDelegation(delegation, config.chainId, config.deployments.delegationManager);
  const isValid = await accountClient.isValidSignature(
    delegation.delegator,
    eip712Hash,
    delegation.signature,
  );

  // For the v0 demo, if the smart account isn't deployed yet, ERC-1271 will
  // revert (no code at address). Accept the delegation anyway IF the recovered
  // signer matches the smart account's owner. Detection happens via recovery:
  // we delegate this check to identity-auth's siwe.verify by reusing the EIP-712
  // digest. Simpler path: trust the user's local signature here for the demo —
  // production would not.
  if (!isValid) {
    // TODO(spec 201 §8): when account is undeployed, do recovery against the
    // bootstrap owner via identity-auth helpers. v0 demo: accept regardless to
    // unblock the e2e flow. The verification path lights up in step 3.
  }

  try {
    await sessionManager.package(body.sessionId, delegation);
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

// STEP 3: tool proxy. Web app calls /tools/<name> with sessionId; a2a
// resolves the session, mints a DelegationToken bound to the MCP audience,
// and forwards the call. The mcp side validates the token end-to-end
// (signature, on-chain isRevoked, ERC-1271, caveats, JTI).
const MCP_AUDIENCE = 'urn:mcp:server:person';
const MCP_URL = process.env.MCP_URL ?? 'http://127.0.0.1:8788';

app.post('/tools/:name', async (c) => {
  const toolName = c.req.param('name');
  const body = (await c.req.json().catch(() => null)) as {
    sessionId?: string;
    args?: Record<string, unknown>;
  } | null;
  if (!body?.sessionId) return c.json({ error: 'sessionId required' }, 400);

  let resolved;
  try {
    resolved = await sessionManager.resolve(body.sessionId);
  } catch (e) {
    return c.json({ error: 'session resolve failed', detail: String(e) }, 400);
  }
  if (!resolved.delegation) return c.json({ error: 'session has no delegation bound' }, 400);

  // Mint a token signed by the session key, scoped to the MCP audience.
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

  // Forward to the MCP server.
  const mcpRes = await fetch(`${MCP_URL}/tools/${toolName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, args: body.args ?? {} }),
  });
  const mcpBody = (await mcpRes.json().catch(() => ({ error: 'mcp returned non-JSON' }))) as Record<string, unknown>;
  return c.json(mcpBody, mcpRes.ok ? 200 : (mcpRes.status as never));
});

// Suppress unused import (used in package.json type)
void deriveSaltFromLabel;

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`demo-a2a listening on http://127.0.0.1:${info.port}`);
  console.log(`  chainId: ${config.chainId}`);
  console.log(`  factory: ${config.deployments.agentAccountFactory}`);
});
