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
  composeFailHardSinks,
  buildEvent,
  createPiiGuardrailSink,
  type AuditSink,
} from '@agenticprimitives/audit';
import type { Address } from '@agenticprimitives/types';
import {
  upsertDemoProfile,
  getProfile,
  createD1JtiStore,
  createD1AuditSink,
} from './db';
import {
  demoVault,
  RESOURCE_PERSON_PII,
  RESOURCE_ORG_SENSITIVE,
  VAULT_RECORD_PREFIX,
} from './vault';
import { demoEntitlementResolver } from './entitlements';
import type { EntitlementClassification } from '@agenticprimitives/entitlements';
import { authorizeDecrypt } from './kas';
import { resolveAgentName } from './naming';
import {
  createProtectedResourceMetadata,
  serveProtectedResourceMetadata,
  validateMcpBearerToken,
  resolveGrantBundleFromToken,
  parseBearer,
  buildUnauthorizedResponse,
  buildInsufficientScopeResponse,
  MCP_OAUTH_SCOPES,
} from '@agenticprimitives/mcp-oauth';
import { createHs256Verify, createVaultGrantBundleStore, mintDemoMcpToken } from './oauth';

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

// spec 277 Phase 5 — REQUIRED (fail-hard) audit for sensitive key-release/decrypt.
// Unlike buildAuditSink (fail-soft telemetry), this composes the durable D1 sink
// fail-HARD: if the commit can't persist, the write throws and the caller fails
// closed (no decrypt, no data). PII guardrail still redacts — events carry only
// ids/refs/field-names, never raw PII (spec §16). Action vocabulary is demo-mcp's
// own (documented in docs/audit/guide.md): key_release.approved, vault.object.decrypted.
function requiredAuditSink(env: Env): AuditSink {
  return composeFailHardSinks(createPiiGuardrailSink(createD1AuditSink(env.DB), { mode: 'redact' }));
}

/** Emit a required (fail-hard) audit event; returns false if it could not commit
 *  (the caller must then fail closed and NOT release plaintext). */
async function recordRequiredRelease(
  env: Env,
  correlationId: string | undefined,
  ev: { principal: string; resource: string; servedBy: string; fields?: string[]; classification: string; grantId?: string; jti?: string },
): Promise<boolean> {
  try {
    await requiredAuditSink(env).write(
      buildEvent({
        action: 'key_release.approved',
        outcome: 'success',
        actor: { type: 'service', id: ev.principal },
        subject: { type: 'vault-object', id: `${ev.principal.toLowerCase()}:${ev.resource}` },
        correlationId,
        context: {
          resource: ev.resource,
          // flat scalar context (audit events index flat keys; never raw PII)
          fields: ev.fields && ev.fields.length > 0 ? ev.fields.join(',') : null,
          fieldCount: ev.fields ? ev.fields.length : 0,
          classification: ev.classification,
          grantId: ev.grantId ?? null,
          jti: ev.jti ?? null,
          servedBy: ev.servedBy,
        },
      }),
    );
    return true;
  } catch (e) {
    console.error('[demo-mcp] required audit failed — failing closed (no decrypt):', e instanceof Error ? e.message : String(e));
    return false;
  }
}

// spec 277 — the shared sensitive-read authority chain (entitlement → one-time
// DecryptGrant/KAS → required fail-hard audit → projected decrypt). Both the
// service-MAC tool routes (get_pii/get_org_sensitive) AND the public OAuth /mcp
// route run the SAME chain keyed by `principal` — OAuth is only ingress, never
// authority (spec 277 §6). The handler never decrypts directly.
interface SensitiveReadSpec {
  resource: string;
  classification: EntitlementClassification;
  toolName: string;
  servedBy: string;
}
type SensitiveReadResult =
  | { ok: false; error: string; reason?: string; served_by: string }
  | { ok: true; record: unknown; subject_name: string | null };

async function readSensitive(
  env: Env,
  ctx: { principal: string; args?: { fields?: string[]; purpose?: string }; correlationId: string | undefined; audience: string },
  spec: SensitiveReadSpec,
): Promise<SensitiveReadResult> {
  const { principal, args } = ctx;
  const requestedFields = Array.isArray(args?.fields) ? args!.fields : undefined;
  const purpose = typeof args?.purpose === 'string' ? args.purpose : undefined;

  // Phase 3: resolve the entitlement BEFORE decrypting; allowedFields scopes the projection.
  const decision = await demoEntitlementResolver().resolve({
    actor: principal,
    principal,
    audience: ctx.audience,
    resource: spec.resource,
    action: 'read',
    fields: requestedFields,
    purpose,
    classification: spec.classification,
    at: new Date(),
  });
  if (decision.decision === 'deny') return { ok: false, error: 'entitlement_denied', reason: decision.reason, served_by: spec.servedBy };

  // Phase 4: one-time DecryptGrant gated by the KAS — releasedFields scopes the projection.
  const release = await authorizeDecrypt({
    principal,
    audience: ctx.audience,
    serverId: 'demo-mcp',
    toolName: spec.toolName,
    args: args ?? {},
    resource: spec.resource,
    classification: spec.classification,
    allowedFields: decision.allowedFields,
    purpose,
    entitlementIds: decision.matchedCredentials,
  });
  if (release.decision === 'deny') return { ok: false, error: 'key_release_denied', reason: release.reason, served_by: spec.servedBy };

  // Phase 5: REQUIRED (fail-hard) audit BEFORE decrypt — if it can't commit, fail closed.
  const audited = await recordRequiredRelease(env, ctx.correlationId, {
    principal, resource: spec.resource, servedBy: spec.servedBy,
    fields: release.releasedFields, classification: spec.classification, grantId: release.grantId, jti: release.jti,
  });
  if (!audited) return { ok: false, error: 'audit_required_failed', served_by: spec.servedBy };

  // KAS authorized + audit committed → vault decrypts (Phase 2) only the released fields (Phase 3).
  const vault = demoVault(env);
  const obj = await vault.read({ owner: principal, resource: spec.resource, fields: release.releasedFields });
  const subject_name = await resolveAgentName(env, principal);
  return { ok: true, record: obj?.data ?? null, subject_name };
}

export interface Env {
  DB: D1Database;

  RPC_URL: string;
  CHAIN_ID: string;
  MCP_AUDIENCE: string;

  // Naming service (single-call reverseResolveString; no fallback).
  // Optional: when unset, read tools simply omit the `.agent` name label.
  AGENT_NAME_REGISTRY?: string;
  AGENT_NAME_UNIVERSAL_RESOLVER?: string;

  DELEGATION_MANAGER: string;
  TIMESTAMP_ENFORCER: string;
  ALLOWED_TARGETS_ENFORCER: string;
  ALLOWED_METHODS_ENFORCER: string;
  VALUE_ENFORCER: string;
  /**
   * DEL-001 (spec 270 v4) — the deployed UniversalSignatureValidator. Threaded into the verifier
   * (ERC-1271 / ERC-6492 / ECDSA) when a client-minted token requires session-key↔delegator binding.
   * Sourced from packages/contracts/deployments-<network>.json's `universalSignatureValidator`.
   * Empty/unset ⇒ binding can't be enforced; treat empty as undefined (wrangler binds `""`).
   */
  UNIVERSAL_SIGNATURE_VALIDATOR?: string;
  /**
   * Shared HMAC secret for service-mac verification (audit C1).
   * Same value as demo-a2a's A2A_MAC_SECRET. When unset, the
   * service-mac middleware fails closed in production
   * (NODE_ENV === 'production') and bypasses with a loud warning in
   * dev for ergonomic local hacking. Production preflight enforces
   * its presence.
   */
  A2A_MAC_SECRET?: string;

  // ─── Vault envelope encryption (spec 277 Phase 2) ─────────────────────
  /**
   * Master secret (hex, ≥32 bytes) for the LocalAesProvider DEK-wrapping backend the vault
   * adapter uses to envelope-encrypt PII at rest. Testnet-demo grade — a managed KMS backend
   * MUST replace this before any real-value data. Seeded by set-cloudflare-secrets.sh.
   */
  VAULT_MASTER_KEY?: string;
  /**
   * Acknowledge local-AES envelope keys on a prod-like runtime. On Workers `NODE_ENV` is unset, so
   * key-custody's LocalAesProvider fails closed unless this opt-in is set; the vault adapter bridges
   * this binding var into `process.env` (where the guard reads it). 'true' for the demo only.
   */
  A2A_ALLOW_LOCAL_ENVELOPE_KEY?: string;

  // ─── OAuth ingress (spec 277 Phase 6) ─────────────────────────────────
  /**
   * HS256 signing secret for the demo MCP authorization endpoint. Stands in for a real
   * authorization server + JWKS (demo-grade): the OAuth `/mcp` route is ONLY a public-client
   * ingress adapter — the real authority chain (entitlement → KAS → required audit → decrypt)
   * re-runs server-side off the grant bundle's principal, so the token is never trusted as
   * authority. Required for `/oauth/token` + `/mcp`; when unset those routes fail closed.
   */
  OAUTH_SIGNING_SECRET?: string;
  /**
   * Enables the OPEN demo authorization endpoint (`/oauth/token`). Fail-closed: the route
   * 404s unless this is exactly 'true'. The testnet demo sets it (mock seed data only); a
   * real production leaves it unset and wires a real authorization server + JWKS instead.
   */
  DEMO_OAUTH_MINT_ENABLED?: string;
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
    // MCP reads are off-chain; the on-chain action caveats (Value /
    // AllowedTargets / AllowedMethods) are conceptually inert for them.
    // Opt the evaluator into "treat inert-without-context as allowed"
    // so the same site-delegation works for both on-chain redemption
    // AND off-chain read calls.
    enforceOnChain: true,
    jtiStore: createD1JtiStore(env.DB),
    // requireDeployed defaults to true (fail-closed). The demo deploys smart
    // accounts via paymaster-sponsored UserOp in Step 1.5 before any
    // delegation is issued, so ERC-1271 verification against the live
    // on-chain contract is the production-grade behavior.
    //
    // DEL-001 (ADR-0036): the delegation library now ENFORCES the session-delegate binding by default.
    // This base (persona / non-client-minted) path issues UNBOUND tokens (the demo's deterministic
    // operator-key story — accepted testnet hole C-1), so it EXPLICITLY opts out. Client-minted vault
    // calls use `vaultConfig`, which keeps the default (binding enforced). The opt-out is greppable.
    allowUnboundSessionToken: true,
  };
}

// DEL-001 (spec 270 v4) — the verify config for a vault call, ENFORCING the session-key↔delegator
// binding when the request is client-minted. demo-a2a sets `enforceBinding` ONLY on the forwarded
// client-mint path (per-source binding); the persona/admin path leaves it false, so those tokens
// (no leaf) keep verifying under the legacy config. The signal rides the service-MAC-authenticated
// body, so it's unforgeable. When enforcing, we ALSO switch to the UniversalSignatureValidator so the
// leaf validates under any connection strategy (and counterfactual SAs via ERC-6492 — `requireDeployed`
// becomes moot on that surface). A `""`/unset USV is treated as undefined (wrangler binds empty strings).
function vaultConfig(env: Env, enforceBinding: boolean | undefined): McpResourceVerifyConfig {
  if (!enforceBinding) return baseConfig(env);
  const usv = env.UNIVERSAL_SIGNATURE_VALIDATOR?.trim();
  if (!usv) {
    // Fail-closed: the caller asked us to enforce binding but we have no validator to do it with.
    // Thrown inside the route's try → mapped to a 500 (rejects the call) rather than verifying weakly.
    throw new Error('binding enforcement requested but UNIVERSAL_SIGNATURE_VALIDATOR is unset (fail-closed)');
  }
  return {
    ...baseConfig(env),
    // DEL-001 (ADR-0036): client-mint path — ENFORCE the binding (the library default). We override
    // baseConfig's persona opt-out back to false so an unbound token on this path is REJECTED, and wire
    // the UniversalSignatureValidator so the leaf validates under any connection strategy.
    allowUnboundSessionToken: false,
    universalSignatureValidator: usv as Address,
  };
}

// Variables stashed on the Hono context by the service-mac middleware
// so the tool route handlers don't need to re-read the body (Hono
// consumes the stream on first read).
interface Variables {
  parsedBody: { token?: string; args?: Record<string, unknown>; enforceBinding?: boolean };
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
      // Label the owner with its `.agent` name (single-call resolve).
      const owner_name = await resolveAgentName(c.env, principal);
      return { ok: true, profile, owner_name };
    },
    {
      toolName: 'get_profile',
      classification: GET_PROFILE_CLASSIFICATION,
      auditSink,
      correlationId: getCorrelationId(c),
      // Hard-gate at wrapper construction: missing classification or
      // auditSink throws BEFORE the handler is registered (audit P0-2).
      environment: (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'
        ? 'production'
        : 'development'),
    },
  );

  try {
    const result = await handler({ token: body.token, args: body.args ?? {} });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code, (e as any).reason, e.stack); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

// ─── get_pii — delegation-verified PII read (Person MCP) ─────────────────
//
// Returns the PII record keyed by the *delegator* of the inbound token.
// The principal recovered by `withDelegation` IS the delegator — so the
// request "Read Alice's PII via Alice→Bob delegation" lands here as
// `principal = Alice`. Mock data is seeded lazily on first read.

// Tier=low keeps the read-only PII tool on the T1 path (no QuorumCaveat
// requirement, no on-chain acceptance gate). Production deployments may
// classify PII as `medium` once the Act-5 delegations also carry the
// QuorumCaveat the policy demands.
const GET_PII_CLASSIFICATION = {
  '@sa-tool': 'delegation-verified',
  '@sa-auth': 'session-token',
  '@sa-risk-tier': 'low',
} as const;
declareTool({ name: 'get_pii' }, GET_PII_CLASSIFICATION);

app.post('/tools/get_pii', async (c) => {
  const body = c.get('parsedBody');
  if (!body?.token) return c.json({ error: 'token required' }, 400);
  const auditSink = buildAuditSink(c.env);
  type Args = { args?: { fields?: string[]; purpose?: string } };
  const handler = withDelegation<Args>(
    baseConfig(c.env),
    async ({ principal, args }) => {
      const r = await readSensitive(
        c.env,
        { principal, args, correlationId: getCorrelationId(c), audience: c.env.MCP_AUDIENCE },
        { resource: RESOURCE_PERSON_PII, classification: 'pii.sensitive', toolName: 'get_pii', servedBy: 'demo-mcp:get_pii' },
      );
      if (!r.ok) return r;
      return { ok: true, subject: principal, subject_name: r.subject_name, record: r.record, served_by: 'demo-mcp:get_pii' };
    },
    {
      toolName: 'get_pii',
      classification: GET_PII_CLASSIFICATION,
      auditSink,
      correlationId: getCorrelationId(c),
      // Hard-gate at wrapper construction: missing classification or
      // auditSink throws BEFORE the handler is registered (audit P0-2).
      environment: (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'
        ? 'production'
        : 'development'),
    },
  );
  try {
    const result = await handler({ token: body.token, args: body.args ?? {} });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code, (e as any).reason, e.stack); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

// ─── get_org_sensitive — delegation-verified Org data read (Org MCP) ─────
//
// Returns the sensitive Org record keyed by the *delegator* of the
// inbound token. Used in Act 6: caller presents Org→Alice/Bob
// delegation, `principal` resolves to the Org address, MCP returns
// Org-internal data (revenue, EIN, banking, …).

// Same rationale as get_pii — kept at T1 for the demo. Bumping to T3
// (`high`) would require Act 5 to attach a QuorumCaveat naming the
// Org's 2-of-N custodian set to every Org-sensitive delegation.
const GET_ORG_SENSITIVE_CLASSIFICATION = {
  '@sa-tool': 'delegation-verified',
  '@sa-auth': 'session-token',
  '@sa-risk-tier': 'low',
} as const;
declareTool({ name: 'get_org_sensitive' }, GET_ORG_SENSITIVE_CLASSIFICATION);

app.post('/tools/get_org_sensitive', async (c) => {
  const body = c.get('parsedBody');
  if (!body?.token) return c.json({ error: 'token required' }, 400);
  const auditSink = buildAuditSink(c.env);
  type Args = { args?: { fields?: string[]; purpose?: string } };
  const handler = withDelegation<Args>(
    baseConfig(c.env),
    async ({ principal, args }) => {
      const r = await readSensitive(
        c.env,
        { principal, args, correlationId: getCorrelationId(c), audience: c.env.MCP_AUDIENCE },
        { resource: RESOURCE_ORG_SENSITIVE, classification: 'regulated.high', toolName: 'get_org_sensitive', servedBy: 'demo-mcp:get_org_sensitive' },
      );
      if (!r.ok) return r;
      return { ok: true, org: principal, org_name: r.subject_name, record: r.record, served_by: 'demo-mcp:get_org_sensitive' };
    },
    {
      toolName: 'get_org_sensitive',
      classification: GET_ORG_SENSITIVE_CLASSIFICATION,
      auditSink,
      correlationId: getCorrelationId(c),
      // Hard-gate at wrapper construction: missing classification or
      // auditSink throws BEFORE the handler is registered (audit P0-2).
      environment: (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'
        ? 'production'
        : 'development'),
    },
  );
  try {
    const result = await handler({ token: body.token, args: body.args ?? {} });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code, (e as any).reason, e.stack); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

// ─── Generic per-agent vault (spec 247) ─────────────────────────────────
//
// get/set/list arbitrary JSON for the caller's OWN agent. The principal
// recovered by withDelegation IS the delegator, so every handler keys by
// `principal` — an agent can only touch its own namespace. record_type +
// data shapes are the consuming app's vocabulary (ADR-0021); the tools are
// generic. Reads are T1 (low); writes are T2 (medium) — medium adds no
// quorum/on-chain gate (UV is enforced at the signer), so EOA-custodied
// org agents can write.

const GET_VAULT_RECORD_CLASSIFICATION = {
  '@sa-tool': 'delegation-verified',
  '@sa-auth': 'session-token',
  '@sa-risk-tier': 'low',
} as const;
declareTool({ name: 'get_vault_record' }, GET_VAULT_RECORD_CLASSIFICATION);

app.post('/tools/get_vault_record', async (c) => {
  const body = c.get('parsedBody');
  if (!body?.token) return c.json({ error: 'token required' }, 400);
  const auditSink = buildAuditSink(c.env);
  type Args = { args?: { recordType?: string } };
  try {
    const handler = withDelegation<Args>(
      vaultConfig(c.env, body.enforceBinding),
      async ({ principal, args }) => {
        const recordType = args?.recordType;
        if (!recordType) return { ok: false, error: 'recordType required' };
        const vault = demoVault(c.env);
        const obj = await vault.read({ owner: principal, resource: `${VAULT_RECORD_PREFIX}${recordType}` });
        return { ok: true, owner: principal, recordType, data: obj?.data ?? null, served_by: 'demo-mcp:get_vault_record' };
      },
      {
        toolName: 'get_vault_record',
        classification: GET_VAULT_RECORD_CLASSIFICATION,
        auditSink,
        correlationId: getCorrelationId(c),
        environment: (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'
          ? 'production'
          : 'development'),
      },
    );
    const result = await handler({ token: body.token, args: body.args ?? {} });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code, (e as any).reason, e.stack); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

const SET_VAULT_RECORD_CLASSIFICATION = {
  '@sa-tool': 'delegation-verified',
  '@sa-auth': 'session-token',
  '@sa-risk-tier': 'medium',
} as const;
declareTool({ name: 'set_vault_record' }, SET_VAULT_RECORD_CLASSIFICATION);

app.post('/tools/set_vault_record', async (c) => {
  const body = c.get('parsedBody');
  if (!body?.token) return c.json({ error: 'token required' }, 400);
  const auditSink = buildAuditSink(c.env);
  type Args = { args?: { recordType?: string; data?: unknown } };
  try {
    const handler = withDelegation<Args>(
      vaultConfig(c.env, body.enforceBinding),
      async ({ principal, args }) => {
        const recordType = args?.recordType;
        if (!recordType) return { ok: false, error: 'recordType required' };
        // `data === null` is a soft-delete (tombstone) by contract.
        const vault = demoVault(c.env);
        await vault.write({ owner: principal, resource: `${VAULT_RECORD_PREFIX}${recordType}`, data: args?.data ?? null });
        return { ok: true, owner: principal, recordType, served_by: 'demo-mcp:set_vault_record' };
      },
      {
        toolName: 'set_vault_record',
        classification: SET_VAULT_RECORD_CLASSIFICATION,
        auditSink,
        correlationId: getCorrelationId(c),
        environment: (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'
          ? 'production'
          : 'development'),
      },
    );
    const result = await handler({ token: body.token, args: body.args ?? {} });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code, (e as any).reason, e.stack); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

const LIST_VAULT_RECORD_CLASSIFICATION = {
  '@sa-tool': 'delegation-verified',
  '@sa-auth': 'session-token',
  '@sa-risk-tier': 'low',
} as const;
declareTool({ name: 'list_vault_record' }, LIST_VAULT_RECORD_CLASSIFICATION);

app.post('/tools/list_vault_record', async (c) => {
  const body = c.get('parsedBody');
  if (!body?.token) return c.json({ error: 'token required' }, 400);
  const auditSink = buildAuditSink(c.env);
  type Args = { args?: Record<string, unknown> };
  try {
    const handler = withDelegation<Args>(
      vaultConfig(c.env, body.enforceBinding),
      async ({ principal }) => {
        // Map the vault refs back to the established { record_type, updated_at } shape.
        const vault = demoVault(c.env);
        const refs = await vault.list(principal);
        const records = refs
          .filter((r) => r.resource.startsWith(VAULT_RECORD_PREFIX))
          .map((r) => ({ record_type: r.resource.slice(VAULT_RECORD_PREFIX.length), updated_at: r.updatedAt }));
        return { ok: true, owner: principal, records, served_by: 'demo-mcp:list_vault_record' };
      },
      {
        toolName: 'list_vault_record',
        classification: LIST_VAULT_RECORD_CLASSIFICATION,
        auditSink,
        correlationId: getCorrelationId(c),
        environment: (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'
          ? 'production'
          : 'development'),
      },
    );
    const result = await handler({ token: body.token, args: body.args ?? {} });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code, (e as any).reason, e.stack); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

// ─── OAuth ingress for public HTTP MCP clients (spec 277 Phase 6) ────────
//
// OAuth here is ONLY a compatibility adapter for public HTTP MCP clients — NOT
// the authority model. A validated bearer token carries a ref+hash to an
// Agentic Grant Bundle (stored encrypted in the vault); the REAL delegated-vault
// chain (`readSensitive`: entitlement → KAS → required audit → projected
// decrypt) re-runs server-side off the bundle's principal. Inbound tokens are
// never reused downstream (spec 277 §6–§8, §15).
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   discovery (RFC 9728)
//   POST /oauth/token                                  demo authorization (mint; dev-only)
//   POST /mcp                                          bearer-gated tool call

// The OAuth-exposed tools and their sensitive-read specs (same chain as the
// service-MAC routes). Field authority is NOT in scopes — it lives in the
// entitlement/grant bundle (spec 277 §6.2).
const OAUTH_TOOL_SPECS: Record<string, SensitiveReadSpec> = {
  get_pii: { resource: RESOURCE_PERSON_PII, classification: 'pii.sensitive', toolName: 'get_pii', servedBy: 'demo-mcp:get_pii' },
  get_org_sensitive: { resource: RESOURCE_ORG_SENSITIVE, classification: 'regulated.high', toolName: 'get_org_sensitive', servedBy: 'demo-mcp:get_org_sensitive' },
};

function protectedResourceResponse(c: { req: { url: string }; env: Env }): Response {
  const origin = new URL(c.req.url).origin;
  return serveProtectedResourceMetadata(
    createProtectedResourceMetadata({
      resource: c.env.MCP_AUDIENCE,
      authorizationServers: [origin],
      scopesSupported: [...MCP_OAUTH_SCOPES],
      resourceDocumentation: `${origin}/health`,
    }),
  );
}

// RFC 9728 discovery. MCP clients probe both the bare path and the
// resource-suffixed `/mcp` variant; serve identical metadata for each.
app.get('/.well-known/oauth-protected-resource', (c) => protectedResourceResponse(c));
app.get('/.well-known/oauth-protected-resource/mcp', (c) => protectedResourceResponse(c));

// Demo authorization endpoint. Stands in for a real authorization server: it
// authenticates NOTHING and mints a token for the requested principal, so it is
// an OPEN mint and MUST stay off in any real deployment. It is gated FAIL-CLOSED
// on the explicit `DEMO_OAUTH_MINT_ENABLED` flag (not NODE_ENV — `wrangler deploy`
// defines NODE_ENV='production', which would tree-shake a registration-time guard
// and 404 the route on the demo Worker too). The route always registers (Workers
// can't read `c.env` at module load), but the handler returns 404 unless the flag
// is 'true'. The demo sets it; a real production leaves it unset (mint disabled)
// and wires a real AS + JWKS — nothing in @agenticprimitives/mcp-oauth changes.
// SAFE for the demo: all vault data is deterministic MOCK seed data derived from
// the address (no real PII), consistent with the demo's other accepted testnet holes.
app.post('/oauth/token', async (c) => {
  if (c.env.DEMO_OAUTH_MINT_ENABLED !== 'true') return c.json({ error: 'not_found' }, 404);
  if (!c.env.OAUTH_SIGNING_SECRET) return c.json({ error: 'unsupported', error_description: 'OAuth ingress not configured (OAUTH_SIGNING_SECRET unset)' }, 501);
  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { body = {}; }
  const principal = typeof body.principal === 'string' ? body.principal : undefined;
  if (!principal) return c.json({ error: 'invalid_request', error_description: 'principal required (demo authorization endpoint)' }, 400);
  const scopeRaw = body.scope;
  const scopes = Array.isArray(scopeRaw)
    ? (scopeRaw.filter((s): s is string => typeof s === 'string'))
    : (typeof scopeRaw === 'string' ? scopeRaw.split(/\s+/).filter(Boolean) : undefined);
  const result = await mintDemoMcpToken(c.env, {
    principal,
    audience: c.env.MCP_AUDIENCE,
    issuer: new URL(c.req.url).origin,
    clientId: typeof body.client_id === 'string' ? body.client_id : undefined,
    scopes,
    fields: Array.isArray(body.fields) ? (body.fields.filter((f): f is string => typeof f === 'string')) : undefined,
    purpose: typeof body.purpose === 'string' ? body.purpose : undefined,
    ttlSeconds: typeof body.ttl_seconds === 'number' ? body.ttl_seconds : undefined,
  });
  return c.json(result);
});

// Public bearer-gated MCP tool call. Validates the token's claims (signature
// injected via HS256), resolves the grant bundle from the vault (anti-swap hash
// check inside), then runs the SAME authority chain as the service-MAC routes.
app.post('/mcp', async (c) => {
  const metaUrl = new URL('/.well-known/oauth-protected-resource', c.req.url).toString();
  if (!c.env.OAUTH_SIGNING_SECRET) return c.json({ error: 'unsupported', error_description: 'OAuth ingress not configured' }, 501);

  const validation = await validateMcpBearerToken(parseBearer(c.req.header('authorization')), {
    verify: createHs256Verify(c.env.OAUTH_SIGNING_SECRET),
    audience: c.env.MCP_AUDIENCE,
    requiredScopes: ['mcp:invoke'],
    requireGrantBinding: true,
  });
  if (!validation.ok) {
    if (validation.reason === 'insufficient_scope') {
      return buildInsufficientScopeResponse({ missingScopes: validation.missingScopes ?? [], resourceMetadataUrl: metaUrl });
    }
    return buildUnauthorizedResponse({ resourceMetadataUrl: metaUrl, errorDescription: validation.reason });
  }
  const claims = validation.claims;
  const principal = claims.ap_principal;
  if (!principal) return buildUnauthorizedResponse({ resourceMetadataUrl: metaUrl, errorDescription: 'grant_principal_missing' });

  // Resolve + validate the referenced grant bundle out of the encrypted vault.
  const resolved = await resolveGrantBundleFromToken(claims, createVaultGrantBundleStore(c.env, principal));
  if (!resolved.ok) return buildUnauthorizedResponse({ resourceMetadataUrl: metaUrl, errorDescription: `grant_${resolved.reason}` });

  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { body = {}; }
  const tool = typeof body.tool === 'string' ? body.tool : (typeof body.method === 'string' ? body.method : '');
  const spec = OAUTH_TOOL_SPECS[tool];
  if (!spec) return c.json({ ok: false, error: 'unknown_tool', tool, supported: Object.keys(OAUTH_TOOL_SPECS) }, 400);
  const rawArgs = (body.args ?? body.params) as { fields?: string[]; purpose?: string } | undefined;

  const r = await readSensitive(
    c.env,
    { principal, args: rawArgs, correlationId: getCorrelationId(c), audience: c.env.MCP_AUDIENCE },
    spec,
  );
  // Authority denials (entitlement/KAS/required-audit) return 200 with {ok:false},
  // matching the service-MAC tool routes — they are policy outcomes, not transport errors.
  if (!r.ok) return c.json(r);
  return c.json({ ok: true, tool, principal, name: r.subject_name, record: r.record, served_by: spec.servedBy, grant_ref: resolved.bundle.id });
});

// R7.4: pre-declare update_profile so the preflight (N10.2) doesn't flag
// the route as unclassified. The handler itself is still a 501 stub for
// the demo; when it gets implemented, the classification is already in
// place so withDelegation's production-strict default won't block the
// first real request.
const UPDATE_PROFILE_CLASSIFICATION = {
  '@sa-tool': 'delegation-verified',
  '@sa-auth': 'session-token',
  '@sa-risk-tier': 'medium',
} as const;
declareTool({ name: 'update_profile' }, UPDATE_PROFILE_CLASSIFICATION);

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
