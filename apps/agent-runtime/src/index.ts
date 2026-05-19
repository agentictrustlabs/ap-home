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
import type { Address, Hex } from '@agenticprimitives/types';
import { loadConfig } from './config';

const config = loadConfig();

const accountClient = new AgentAccountClient({
  rpcUrl: config.rpcUrl,
  chainId: config.chainId,
  entryPoint: config.deployments.entryPoint,
  factory: config.deployments.agentAccountFactory,
});

const app = new Hono();

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'demo-a2a',
    chainId: config.chainId,
    factory: config.deployments.agentAccountFactory,
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

// Other routes still stubbed
app.post('/session/init', (c) => c.json({ error: 'not implemented' }, 501));
app.post('/session/package', (c) => c.json({ error: 'not implemented' }, 501));
app.post('/tools/:name', (c) => c.json({ error: 'not implemented' }, 501));

// Suppress unused import (used in package.json type)
void deriveSaltFromLabel;

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`demo-a2a listening on http://127.0.0.1:${info.port}`);
  console.log(`  chainId: ${config.chainId}`);
  console.log(`  factory: ${config.deployments.agentAccountFactory}`);
});
