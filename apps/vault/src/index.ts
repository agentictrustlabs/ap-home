import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { upsertDemoProfile, getProfile } from './db';
// Once @agenticprimitives/mcp-runtime is real:
// import { withDelegation, createSqliteJtiStore } from '@agenticprimitives/mcp-runtime';
// import { declareTool } from '@agenticprimitives/tool-policy';

const PORT = Number(process.env.PORT ?? 8788);

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, service: 'demo-mcp' }));

// Once mcp-runtime is real, these are wrapped via withDelegation(config, ...).
// For now they return 501 so the demo flow's gating point is visible.

// @sa-tool delegation-verified
// @sa-auth session-token
// @sa-risk-tier low
app.post('/tools/get_profile', async (c) => {
  // TODO: replace with withDelegation(config, async ({ principal }) => getProfile(principal))
  return c.json({ error: 'not implemented (mcp-runtime stub)' }, 501);
});

// @sa-tool delegation-verified
// @sa-auth session-token
// @sa-risk-tier medium
// @sa-validation json-schema
app.post('/tools/update_profile', async (c) => {
  return c.json({ error: 'not implemented (mcp-runtime stub)' }, 501);
});

// Dev-only seeder: hits the PII store directly without delegation checks.
// Lets the demo show "data exists" before the auth pipeline is wired.
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
  console.log(`  PII store: ${process.env.MCP_DB_PATH ?? './demo-mcp.db'}`);
});
