// demo-mcp as a Cloudflare Worker with D1.
//
// Local dev:  wrangler dev (port 8788; uses local D1 SQLite)
// Production: wrangler deploy + wrangler d1 migrations apply demo-mcp

import { Hono } from 'hono';
import {
  withDelegation,
  McpAuthError,
  verifyServiceMac,
  bodyDigestHex,
} from '@agenticprimitives/mcp-runtime';
import type { McpResourceVerifyConfig } from '@agenticprimitives/mcp-runtime';
import { buildMacProvider } from '@agenticprimitives/key-custody';
import { declareTool } from '@agenticprimitives/tool-policy';
import {
  createConsoleAuditSink,
  composeSinks,
  buildEvent,
  createPiiGuardrailSink,
  type AuditSink,
} from '@agenticprimitives/audit';
import type { Address } from '@agenticprimitives/types';
import {
  upsertDemoProfile,
  getProfile,
  upsertDemoPii,
  getPii,
  upsertDemoOrgSensitive,
  getOrgSensitive,
  createD1JtiStore,
  createD1AuditSink,
} from './db';

// Per-request audit sink (audit C3 pass 3b). composeSinks fans out to:
//   - console (surfaces in `wrangler tail` for live ops debugging)
//   - D1 (durable, queryable forensics; append-only table per
//     migration 0002)
// composeSinks isolates per-sink failures so a D1 outage never breaks
// the request flow. Built per-request because the D1 sink needs
// c.env.DB.
function buildAuditSink(env: Env): AuditSink {
  // Pass 5g (AUD-1): wrap the durable D1 sink with the PII guardrail so
  // accidental secret leaks in emitted events get redacted at the sink
  // boundary BEFORE they hit the append-only forensics table. Per the
  // package CLAUDE.md invariant this is defense-in-depth — emitters
  // still MUST hash/omit raw secrets — but D1 rows are forever, so a
  // single sloppy emitter would otherwise poison the trail permanently.
  // Console intentionally bypasses the guardrail: ops debugging in
  // `wrangler tail` benefits from raw values, and worker logs roll off.
  return composeSinks(
    createConsoleAuditSink({ prefix: '[AUDIT mcp]' }),
    createPiiGuardrailSink(createD1AuditSink(env.DB), {
      mode: 'redact',
      onDetect: ({ event, findings }) => {
        console.warn(
          `[AUDIT mcp] PII guardrail flagged event ${event.id} (action=${event.action}):`,
          findings.map((f) => `${f.path}=${f.reason}/${f.preview}`).join(', '),
        );
      },
    }),
  );
}

/**
 * Extract the request's correlation ID for audit-trail stitching.
 *
 * Prefers `X-Correlation-Id` from the upstream caller (demo-a2a sets this
 * per the pass-5b wiring so a single user action correlates across both
 * workers). Falls back to Cloudflare's `cf-ray` for external clients that
 * don't set the header — but worker-to-worker service-binding fetches
 * don't carry `cf-ray`, so without this preference the cross-service
 * trail breaks (correlation_id ends up NULL in D1).
 */
function getCorrelationId(c: { req: { header: (k: string) => string | undefined } }): string | undefined {
  return c.req.header('X-Correlation-Id') ?? c.req.header('cf-ray') ?? undefined;
}

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
  /**
   * Shared HMAC secret for service-mac verification (audit C1).
   * Same value as demo-a2a's A2A_MAC_SECRET. When unset, the
   * service-mac middleware fails closed in production
   * (NODE_ENV === 'production') and bypasses with a loud warning in
   * dev for ergonomic local hacking. Production preflight enforces
   * its presence.
   */
  A2A_MAC_SECRET?: string;
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
    // requireDeployed defaults to true (fail-closed). The demo deploys smart
    // accounts via paymaster-sponsored UserOp in Step 1.5 before any
    // delegation is issued, so ERC-1271 verification against the live
    // on-chain contract is the production-grade behavior.
  };
}

// Variables stashed on the Hono context by the service-mac middleware
// so the tool route handlers don't need to re-read the body (Hono
// consumes the stream on first read).
interface Variables {
  parsedBody: { token?: string; args?: Record<string, unknown> };
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/health', (c) =>
  c.json({ ok: true, service: 'demo-mcp', runtime: 'cloudflare-workers' }),
);

// ─── Service-MAC verification middleware (audit C1) ───────────────────
//
// Runs BEFORE the tool routes. Verifies the A2A→MCP envelope:
//   - X-A2A-Mac, X-A2A-Mac-Nonce, X-A2A-Mac-Timestamp, X-A2A-Mac-Key-Id headers
//   - HMAC binds audience + service + route + nonce + timestamp + body digest
//   - Nonce single-use via the D1 JTI store (replay protection)
//   - Clock skew bounded (default 60s)
//
// Fail-closed: missing/invalid → 401. In production, also requires the
// shared secret to be present (preflight enforces).
app.use('/tools/*', async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const auditSink = buildAuditSink(c.env);
  const mac = c.req.header('X-A2A-Mac');
  const nonce = c.req.header('X-A2A-Mac-Nonce');
  const timestamp = c.req.header('X-A2A-Mac-Timestamp');
  const keyId = c.req.header('X-A2A-Mac-Key-Id');
  const correlationId = getCorrelationId(c);
  if (!mac || !nonce || !timestamp || !keyId) {
    // Emit before returning so missing-header rejections also land in
    // the audit trail. Audit C3 follow-up: belongs alongside the other
    // service-mac reject paths.
    await auditSink
      .write(
        buildEvent({
          action: 'mcp-runtime.service-mac.reject',
          outcome: 'denied',
          correlationId,
          actor: { type: 'service', id: 'unknown' },
          subject: { type: 'tool', id: c.req.path.split('/').pop() ?? '' },
          audience: c.env.MCP_AUDIENCE,
          reason: 'service-mac headers required',
        }),
      )
      .catch(() => {});
    return c.json({ error: 'service-mac headers required' }, 401);
  }
  if (!c.env.A2A_MAC_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[demo-mcp] A2A_MAC_SECRET is not set in production — fail-closed');
      await auditSink
        .write(
          buildEvent({
            action: 'mcp-runtime.service-mac.reject',
            outcome: 'error',
            correlationId,
            audience: c.env.MCP_AUDIENCE,
            reason: 'A2A_MAC_SECRET unset in production',
          }),
        )
        .catch(() => {});
      return c.json({ error: 'service-mac unavailable' }, 401);
    }
    console.warn('[demo-mcp] A2A_MAC_SECRET unset — dev bypass; production would 401');
    return next();
  }
  // Buffer the body once: the MAC verifier needs the EXACT wire bytes
  // (so the sha256 matches what demo-a2a computed), and Hono's body
  // stream is single-read. We stash the parsed object on the context
  // so the route handler reads it from there rather than re-consuming
  // the body.
  const rawBody = await c.req.text();
  const route = (c.req.path.split('/').pop() ?? '').trim();
  const provider = buildMacProvider(c.env.MCP_AUDIENCE, {
    backend: 'local-aes',
    config: { sessionSecretHex: c.env.A2A_MAC_SECRET },
  });
  const result = await verifyServiceMac({
    ctx: {
      audience: c.env.MCP_AUDIENCE,
      service: 'a2a-to-mcp',
      route,
      bodyDigest: bodyDigestHex(rawBody),
    },
    headers: { mac, nonce, timestamp, keyId },
    provider,
    jtiStore: createD1JtiStore(c.env.DB),
    auditSink,
    correlationId: getCorrelationId(c),
  });
  if (!result.ok) {
    console.error(`[demo-mcp] service-mac rejected:`, result.reason);
    return c.json({ error: 'service-mac rejected' }, 401);
  }
  // Parse + stash for the route handler.
  let parsed: Variables['parsedBody'] = {};
  if (rawBody.length > 0) {
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'malformed body' }, 400);
    }
  }
  c.set('parsedBody', parsed);
  return next();
});

// ─── get_profile — delegation-verified, low-risk read ────────────────────

// Classification — both the metadata declaration (for lint + future
// audit context) AND a value passed into withDelegation so the policy
// engine evaluates each call. Audit H2 (closed by Pass 2).
const GET_PROFILE_CLASSIFICATION = {
  '@sa-tool': 'delegation-verified',
  '@sa-auth': 'session-token',
  '@sa-risk-tier': 'low',
} as const;
declareTool({ name: 'get_profile' }, GET_PROFILE_CLASSIFICATION);

app.post('/tools/get_profile', async (c) => {
  // Body parsed by the service-mac middleware; we read from context.
  const body = c.get('parsedBody');
  if (!body?.token) return c.json({ error: 'token required' }, 400);

  const auditSink = buildAuditSink(c.env);
  type Args = { args?: Record<string, unknown> };
  const handler = withDelegation<Args>(
    baseConfig(c.env),
    async ({ principal }) => {
      await upsertDemoProfile(c.env.DB, principal);
      const profile = await getProfile(c.env.DB, principal);
      return { ok: true, profile };
    },
    {
      toolName: 'get_profile',
      classification: GET_PROFILE_CLASSIFICATION,
      auditSink,
      correlationId: getCorrelationId(c),
    },
  );

  try {
    const result = await handler({ token: body.token, args: body.args ?? {} });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) return c.json({ error: 'auth failed', detail: e.message }, 401);
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

// ─── get_pii — delegation-verified PII read (Person MCP) ─────────────────
//
// Returns the PII record keyed by the *delegator* of the inbound token.
// The principal recovered by `withDelegation` IS the delegator — so the
// request "Read Alice's PII via Alice→Bob delegation" lands here as
// `principal = Alice`. Mock data is seeded lazily on first read.

const GET_PII_CLASSIFICATION = {
  '@sa-tool': 'delegation-verified',
  '@sa-auth': 'session-token',
  '@sa-risk-tier': 'medium',
} as const;
declareTool({ name: 'get_pii' }, GET_PII_CLASSIFICATION);

app.post('/tools/get_pii', async (c) => {
  const body = c.get('parsedBody');
  if (!body?.token) return c.json({ error: 'token required' }, 400);
  const auditSink = buildAuditSink(c.env);
  type Args = { args?: Record<string, unknown> };
  const handler = withDelegation<Args>(
    baseConfig(c.env),
    async ({ principal }) => {
      // Lazy-seed so the first access for a freshly-claimed seat works.
      await upsertDemoPii(c.env.DB, principal);
      const record = await getPii(c.env.DB, principal);
      return {
        ok: true,
        subject: principal,
        record,
        served_by: 'demo-mcp:get_pii',
      };
    },
    {
      toolName: 'get_pii',
      classification: GET_PII_CLASSIFICATION,
      auditSink,
      correlationId: getCorrelationId(c),
    },
  );
  try {
    const result = await handler({ token: body.token, args: body.args ?? {} });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) return c.json({ error: 'auth failed', detail: e.message }, 401);
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

// ─── get_org_sensitive — delegation-verified Org data read (Org MCP) ─────
//
// Returns the sensitive Org record keyed by the *delegator* of the
// inbound token. Used in Act 6: caller presents Org→Alice/Bob
// delegation, `principal` resolves to the Org address, MCP returns
// Org-internal data (revenue, EIN, banking, …).

const GET_ORG_SENSITIVE_CLASSIFICATION = {
  '@sa-tool': 'delegation-verified',
  '@sa-auth': 'session-token',
  '@sa-risk-tier': 'high',
} as const;
declareTool({ name: 'get_org_sensitive' }, GET_ORG_SENSITIVE_CLASSIFICATION);

app.post('/tools/get_org_sensitive', async (c) => {
  const body = c.get('parsedBody');
  if (!body?.token) return c.json({ error: 'token required' }, 400);
  const auditSink = buildAuditSink(c.env);
  type Args = { args?: Record<string, unknown> };
  const handler = withDelegation<Args>(
    baseConfig(c.env),
    async ({ principal }) => {
      await upsertDemoOrgSensitive(c.env.DB, principal);
      const record = await getOrgSensitive(c.env.DB, principal);
      return {
        ok: true,
        org: principal,
        record,
        served_by: 'demo-mcp:get_org_sensitive',
      };
    },
    {
      toolName: 'get_org_sensitive',
      classification: GET_ORG_SENSITIVE_CLASSIFICATION,
      auditSink,
      correlationId: getCorrelationId(c),
    },
  );
  try {
    const result = await handler({ token: body.token, args: body.args ?? {} });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) return c.json({ error: 'auth failed', detail: e.message }, 401);
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

app.post('/tools/update_profile', (c) => c.json({ error: 'not implemented in demo step 3' }, 501));

// Dev-only seeder. Audit M3: must not exist in production.
// Guard wraps the route REGISTRATION (not just the handler body) so:
//  - the route literally doesn't exist on production Workers (Hono 404s
//    naturally for unknown paths, no "this URL was once interesting"
//    leak)
//  - the production preflight (scripts/check-production-deploy.ts)
//    statically detects this as a properly-guarded dev route
if (process.env.NODE_ENV !== 'production') {
  app.post('/_dev/seed', async (c) => {
    const { address } = (await c.req.json()) as { address?: string };
    if (typeof address !== 'string') return c.json({ error: 'address required' }, 400);
    const profile = await upsertDemoProfile(c.env.DB, address);
    return c.json({ ok: true, profile });
  });
}

export default app;
