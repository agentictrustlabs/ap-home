// demo-mcp as a Cloudflare Worker with D1.
//
// Local dev:  wrangler dev (port 8788; uses local D1 SQLite)
// Production: wrangler deploy + wrangler d1 migrations apply demo-mcp

import { Hono } from 'hono';
import { withDelegation, McpAuthError } from '@agenticprimitives/mcp-runtime';
import type { McpResourceVerifyConfig } from '@agenticprimitives/mcp-runtime';
import { declareTool } from '@agenticprimitives/tool-policy';
import type { Address } from '@agenticprimitives/types';
import { upsertDemoProfile, getProfile, createD1JtiStore } from './db';

export interface Env {
  DB: D1Database;

  RPC_URL: string;
  CHAIN_ID: string;
  MCP_AUDIENCE: string;

  DELEGATION_MANAGER: string;
  TIMESTAMP_ENFORCER: string;
  ALLOWED_TARGETS_ENFORCER: string;
  ALLOWED_METHODS_ENFORCER: string;
  VALUE_ENFORCER: string;
}

function baseConfig(env: Env): McpResourceVerifyConfig {
  return {
    audience: env.MCP_AUDIENCE,
    chainId: Number(env.CHAIN_ID),
    rpcUrl: env.RPC_URL,
    delegationManager: env.DELEGATION_MANAGER as Address,
    enforcerMap: {
      delegationManager: env.DELEGATION_MANAGER as Address,
      timestamp: env.TIMESTAMP_ENFORCER as Address,
      value: env.VALUE_ENFORCER as Address,
      allowedTargets: env.ALLOWED_TARGETS_ENFORCER as Address,
      allowedMethods: env.ALLOWED_METHODS_ENFORCER as Address,
    },
    jtiStore: createD1JtiStore(env.DB),
    // Demo opt-in: the demo doesn't deploy the smart account before issuing
    // delegations (counterfactual address only), so ERC-1271 can't be checked
    // on-chain. Production code MUST remove this — see Task #43 / spec 120 §4.5.
    requireDeployed: false,
  };
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) =>
  c.json({ ok: true, service: 'demo-mcp', runtime: 'cloudflare-workers' }),
);

// ─── get_profile — delegation-verified, low-risk read ────────────────────

// Classification (lint surface; tool-policy.evaluatePolicy enforcement will
// live alongside the wrapper in v0.1).
declareTool(
  { name: 'get_profile' },
  { '@sa-tool': 'delegation-verified', '@sa-auth': 'session-token', '@sa-risk-tier': 'low' },
);

app.post('/tools/get_profile', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    token?: string;
    args?: Record<string, unknown>;
  } | null;
  if (!body?.token) return c.json({ error: 'token required' }, 400);

  type Args = { args?: Record<string, unknown> };
  const handler = withDelegation<Args>(
    baseConfig(c.env),
    async ({ principal }) => {
      await upsertDemoProfile(c.env.DB, principal);
      const profile = await getProfile(c.env.DB, principal);
      return { ok: true, profile };
    },
    { toolName: 'get_profile' },
  );

  try {
    const result = await handler({ token: body.token, args: body.args ?? {} });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) return c.json({ error: 'auth failed' }, 401);
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

app.post('/tools/update_profile', (c) => c.json({ error: 'not implemented in demo step 3' }, 501));

// Dev-only seeder.
app.post('/_dev/seed', async (c) => {
  const { address } = (await c.req.json()) as { address?: string };
  if (typeof address !== 'string') return c.json({ error: 'address required' }, 400);
  const profile = await upsertDemoProfile(c.env.DB, address);
  return c.json({ ok: true, profile });
});

export default app;
