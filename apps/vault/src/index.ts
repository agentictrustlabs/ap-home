import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  withDelegation,
  createMemoryJtiStore,
  McpAuthError,
} from '@agenticprimitives/mcp-runtime';
import type { McpResourceVerifyConfig } from '@agenticprimitives/mcp-runtime';
import { declareTool } from '@agenticprimitives/tool-policy';
import type { Address } from '@agenticprimitives/types';
import { upsertDemoProfile, getProfile } from './db';

const PORT = Number(process.env.PORT ?? 8788);

// Load contract deployments — same JSON the a2a server reads.
function loadDeployments(): {
  chainId: number;
  delegationManager: Address;
  timestampEnforcer: Address;
  allowedTargetsEnforcer: Address;
  allowedMethodsEnforcer: Address;
  valueEnforcer: Address;
} {
  const network = process.env.DEPLOY_NETWORK ?? 'anvil';
  const path = join(
    process.env.DEPLOYMENTS_DIR ?? join(process.cwd(), '..', 'contracts'),
    `deployments-${network}.json`,
  );
  if (!existsSync(path)) {
    throw new Error(
      `demo-mcp: deployments file not found at ${path}. Run \`pnpm dev:contracts\`.`,
    );
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  return {
    chainId: Number(raw.chainId ?? 31337),
    delegationManager: raw.delegationManager as Address,
    timestampEnforcer: raw.timestampEnforcer as Address,
    allowedTargetsEnforcer: raw.allowedTargetsEnforcer as Address,
    allowedMethodsEnforcer: raw.allowedMethodsEnforcer as Address,
    valueEnforcer: raw.valueEnforcer as Address,
  };
}

const deployments = loadDeployments();
const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545';

const baseConfig: McpResourceVerifyConfig = {
  audience: 'urn:mcp:server:person',
  chainId: deployments.chainId,
  rpcUrl,
  delegationManager: deployments.delegationManager,
  enforcerMap: {
    delegationManager: deployments.delegationManager,
    timestamp: deployments.timestampEnforcer,
    value: deployments.valueEnforcer,
    allowedTargets: deployments.allowedTargetsEnforcer,
    allowedMethods: deployments.allowedMethodsEnforcer,
  },
  jtiStore: createMemoryJtiStore(),
};

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, service: 'demo-mcp' }));

// ─── get_profile — delegation-verified, low-risk read ────────────────────
type GetProfileArgs = { args?: Record<string, unknown> };

const handleGetProfile = withDelegation<GetProfileArgs>(
  baseConfig,
  async ({ principal }) => {
    // First call seeds deterministic PII for the principal; subsequent
    // calls return the same profile.
    upsertDemoProfile(principal);
    const profile = getProfile(principal);
    return { ok: true, profile };
  },
  { toolName: 'get_profile' },
);

const getProfileTool = declareTool(
  { name: 'get_profile', handler: handleGetProfile },
  {
    '@sa-tool': 'delegation-verified',
    '@sa-auth': 'session-token',
    '@sa-risk-tier': 'low',
  },
);

app.post('/tools/get_profile', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    token?: string;
    args?: Record<string, unknown>;
  } | null;
  if (!body?.token) return c.json({ error: 'token required' }, 400);

  try {
    const result = await getProfileTool.handler({ token: body.token, args: body.args ?? {} });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) {
      // Externally opaque; details only in stderr (see mcp-runtime).
      return c.json({ error: 'auth failed' }, 401);
    }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

// ─── update_profile — defer; demo step 3 only exercises read ─────────────
app.post('/tools/update_profile', (c) => c.json({ error: 'not implemented in demo step 3' }, 501));

// Dev-only seeder: hits the PII store directly without delegation checks.
// @sa-tool dev-only
// @sa-auth none
app.post('/_dev/seed', async (c) => {
  const { address } = await c.req.json();
  if (typeof address !== 'string') return c.json({ error: 'address required' }, 400);
  const profile = upsertDemoProfile(address);
  return c.json({ ok: true, profile });
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`demo-mcp listening on http://127.0.0.1:${info.port}`);
  console.log(`  chainId: ${deployments.chainId}`);
  console.log(`  delegationManager: ${deployments.delegationManager}`);
  console.log(`  PII store: ${process.env.MCP_DB_PATH ?? './demo-mcp.db'}`);
});
