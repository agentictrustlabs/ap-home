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
import { agenticKmsConfig, isAgenticKms, type AkcsEnv } from './akcs.js';
import { executeGcpProvision, createGcpRestStepExecutor, sanitizeKeyId } from '@agenticprimitives/key-custody/provision-gcp';
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
  type Profile,
  buildSeedProfile,
  createD1JtiStore,
  createD1AuditSink,
  hasSigVerdict,
  putSigVerdict,
} from './db';
import {
  RESOURCE_PROFILE,
  RESOURCE_PERSON_PII,
  RESOURCE_ORG_SENSITIVE,
  VAULT_RECORD_PREFIX,
} from './vault';
import { localKekEnabled, localKekRef, resolvePersonVault, buildVaultKeyVerifier, verifyAndStoreBinding, isVaultKeyBound, isVaultKeyBindingCurrent, getVaultKeyAllowedResources, VAULT_SERVER_ID, type PersonVault } from './vault-key';
import { verifyVaultKeyAuthorization } from '@agenticprimitives/key-authorization';
import { createDurableObjectBudgetStore, type BudgetDoNamespace } from '@agenticprimitives/rate-control-cloudflare';
import { decodeGatewayAssertionToken, verifyGatewayAssertion, createHmacGatewayAssertionVerifier } from '@agenticprimitives/edge-runtime';
// spec 293 — the conformant stateless MCP protocol primitive + surface-catalog capability generation.
import {
  parseJsonRpc,
  parseRequestMeta,
  negotiateProtocolVersion,
  checkRequestIntegrity,
  MethodRegistry,
  RpcError,
  buildServerDiscover,
  withCacheable,
  structuredResult,
  authorityExtensionEntry,
  RPC_ERROR,
} from '@agenticprimitives/mcp-protocol';
import { defineSurface, buildMcpToolsList, buildMcpServerCapabilities, mcpListCacheHint, type SurfaceDescriptor } from '@agenticprimitives/surface-catalog';
import { createChainAuthorityReader, type ChainAuthorityReader, type SignatureInput } from '@agenticprimitives/chain-state';
import { createMemorySoftRateLimiter, type SoftRateLimiter } from '@agenticprimitives/rate-control';
import { createViemChainProvider } from '@agenticprimitives/chain-state-viem';
import { vaultRecordScopeAllows } from '@agenticprimitives/delegation';
import type { Delegation, AgenticInvocationProofV1, DataScopeGrant, VaultRecordScopeGrant } from '@agenticprimitives/delegation';

// Spec 290 §8 — the per-SA hard-budget Durable Object must be exported from the Worker entry so CF can
// bind it. demo-mcp hosts + enforces its own (it is the authority point — it has the verified principal).
export { SmartAgentBudgetDO } from '@agenticprimitives/rate-control-cloudflare';
import { demoEntitlementResolver, ledgerEntitlementResolver, buildOrgEntitlement } from './entitlements';
import { buildReceiptsConfig } from './receipts';
import { buildCredentialVerifier } from './credential-verifier';
import type { EntitlementAction, EntitlementClassification } from '@agenticprimitives/entitlements';
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
  buildInvalidInvocationProofResponse,
  MCP_OAUTH_SCOPES,
} from '@agenticprimitives/mcp-oauth';
import { createHs256Verify, createVaultGrantBundleStore, mintDemoMcpToken } from './oauth';
import { verifyPrincipalControlProof, verifyProvisionControlProof } from './principal-proof';

// Per-request audit sink (audit C3 pass 3b). composeSinks fans out to:
//   - console (surfaces in `wrangler tail` for live ops debugging)
//   - D1 (durable, queryable forensics; append-only table per
//     migration 0002)
// composeSinks isolates per-sink failures so a D1 outage never breaks
// the request flow. Built per-request because the D1 sink needs
// c.env.DB.
// ARCH-H5 (seam audit): forensic-CRITICAL events (a KEK release, a sensitive data read, an authority
// accept) MUST land durably — otherwise tamper-evidence over an incomplete log proves nothing (spec-214
// OP-2). Route those FAIL-HARD (a durable-sink failure throws → the request refuses to commit); telemetry
// stays fail-soft so a D1 blip never breaks a non-critical flow. Matches the audit package's H7-B.7
// "security-critical events use composeFailHardSinks" invariant.
const CRITICAL_AUDIT_ACTION =
  /^(key_release\.|read$|.*\.with-delegation\.accept$|.*\.service-mac\.accept$|delegation\.(mint|revoke)|custody\.|account-custody\.credential|key-custody\.)/;

function buildAuditSink(env: Env): AuditSink {
  // Pass 5g (AUD-1): wrap the durable D1 sink with the PII guardrail so accidental secret leaks in emitted
  // events get redacted at the sink boundary BEFORE they hit the append-only forensics table. Console
  // intentionally bypasses the guardrail: ops debugging in `wrangler tail` benefits from raw values.
  const durable = createPiiGuardrailSink(createD1AuditSink(env.DB), {
    mode: 'redact',
    onDetect: ({ event, findings }) => {
      console.warn(
        `[AUDIT mcp] PII guardrail flagged event ${event.id} (action=${event.action}):`,
        findings.map((f) => `${f.path}=${f.reason}/${f.preview}`).join(', '),
      );
    },
  });
  const consoleSink = createConsoleAuditSink({ prefix: '[AUDIT mcp]' });
  const failSoft = composeSinks(consoleSink, durable);        // telemetry — a D1 blip never breaks the request
  const failHard = composeFailHardSinks(durable, consoleSink); // ARCH-H5 — durable-write failure THROWS
  return {
    async write(event) {
      return (CRITICAL_AUDIT_ACTION.test(event.action) ? failHard : failSoft).write(event);
    },
  };
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

/** Field-scoping (spec 291-A): when the delegation carried DATA_SCOPE grants, RESTRICT the released fields
 *  to what the issuer granted for THIS resource. No grants ⇒ unchanged (owner-self / full-authority reads).
 *  Grants present but none for this resource ⇒ [] (fail-closed: scoped access doesn't reach this resource). */
/** spec 317 §3.2 — per-delegation vault-record-scope gate (Option X). Delegates to the CANONICAL matcher
 *  `vaultRecordScopeAllows` (delegation package, golden-tested) so this server never re-implements the
 *  anchored/op/server matching (security-audit F3 — divergent matchers are where widening creeps in).
 *  When the access delegation carried a VAULT_RECORD_SCOPE caveat (surfaced as `recordScopes` post-verify),
 *  an op is authorized only by a grant for THIS server whose resources cover `resource` (anchored) and
 *  whose ops include `op`; deny-by-default. NO caveat ⇒ inert (binding-only). This NARROWS, never widens,
 *  the vault-key binding: callers MUST still run `authorizePersonVaultOp` (the two gates AND). */
function recordScopeAllows(
  recordScopes: VaultRecordScopeGrant[] | undefined,
  resource: string,
  op: 'read' | 'write' | 'delete',
): boolean {
  return vaultRecordScopeAllows(recordScopes, { server: VAULT_SERVER_ID, resource, op });
}

function applyDataScope(grants: DataScopeGrant[] | undefined, resource: string, requested?: string[]): string[] | undefined {
  if (!grants || grants.length === 0) return requested;
  const allowed = new Set<string>();
  for (const g of grants) if (g.resources.includes(resource)) for (const f of g.fields) allowed.add(f);
  if (!requested || requested.length === 0) return [...allowed];
  return requested.filter((f) => allowed.has(f));
}

async function readSensitive(
  env: Env,
  ctx: { principal: string; args?: { fields?: string[]; purpose?: string }; grants?: DataScopeGrant[]; correlationId: string | undefined; audience: string },
  spec: SensitiveReadSpec,
): Promise<SensitiveReadResult> {
  const { principal, args } = ctx;
  const requestedFields = Array.isArray(args?.fields) ? args!.fields : undefined;
  const purpose = typeof args?.purpose === 'string' ? args.purpose : undefined;

  // spec 278: resolve the person's vault-key binding FIRST. No binding ⇒ fail closed —
  // there is no global key for person data (VKB-D1). The binding selects the person's KEK.
  const pv = await resolvePersonVault(env, principal);
  if (!pv) return { ok: false, error: 'vault_key_unauthorized', served_by: spec.servedBy };

  // Phase 3: resolve the entitlement BEFORE decrypting; allowedFields scopes the projection.
  const decision = await demoEntitlementResolver(buildCredentialVerifier(env)).resolve({
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

  // spec 291-A field-scoping: intersect the entitlement's allowedFields with the delegation's DATA_SCOPE
  // grant for this resource. Owner-self / full-authority delegations carry no grant → unchanged.
  const scopedFields = applyDataScope(ctx.grants, spec.resource, decision.allowedFields);

  // Phase 4 + spec 278: one-time DecryptGrant gated by the KAS, which ALSO requires the
  // per-person vault-key authorization (the person SA authorized THIS host to wield the KEK).
  const release = await authorizeDecrypt({
    principal,
    audience: ctx.audience,
    serverId: VAULT_SERVER_ID,
    toolName: spec.toolName,
    args: args ?? {},
    resource: spec.resource,
    classification: spec.classification,
    allowedFields: scopedFields,
    purpose,
    entitlementIds: decision.matchedCredentials,
    vaultKeyAuthorization: { verifier: buildVaultKeyVerifier(env), authorization: pv.authorization, binding: pv.binding },
  });
  if (release.decision === 'deny') {
    const error = release.reason === 'vault_key_unauthorized' ? 'vault_key_unauthorized' : 'key_release_denied';
    return { ok: false, error, reason: release.reason, served_by: spec.servedBy };
  }

  // Phase 5: REQUIRED (fail-hard) audit BEFORE decrypt — if it can't commit, fail closed.
  const audited = await recordRequiredRelease(env, ctx.correlationId, {
    principal, resource: spec.resource, servedBy: spec.servedBy,
    fields: release.releasedFields, classification: spec.classification, grantId: release.grantId, jti: release.jti,
  });
  if (!audited) return { ok: false, error: 'audit_required_failed', served_by: spec.servedBy };

  // Authorized + audit committed → the person's KEK-backed vault decrypts only the released fields.
  const obj = await pv.vault.read({ owner: principal, resource: spec.resource, fields: release.releasedFields });
  const subject_name = await resolveAgentName(env, principal);
  return { ok: true, record: obj?.data ?? null, subject_name };
}

// spec 290 §6 Stage-3 — the per-Smart-Agent HARD budget, enforced AFTER authority (this runs inside the
// withDelegation handler, so the proof + delegation + policy + JTI already passed), keyed by the verified
// `principal` (= sponsorAgent). Reserve a unit before the op, COMMIT on a served result, RELEASE on a
// data-layer denial or a throw so a budget reservation never burns on a non-served call. Idempotent by
// the proof's one-shot `requestId`. Additive to the on-chain enforcers — never the authority for value
// movement (ADR-0041). Skipped (authority + JTI still apply) when SA_BUDGET is unbound.
async function enforceBudget(
  env: Env,
  principal: string,
  tool: string,
  requestId: string,
  run: () => Promise<unknown>,
): Promise<unknown> {
  if (!env.SA_BUDGET) return run();
  const budget = createDurableObjectBudgetStore({
    namespace: env.SA_BUDGET,
    chainId: Number(env.CHAIN_ID),
    limitUnits: Number(env.SA_BUDGET_LIMIT_UNITS ?? '1000'),
  });
  const reservation = await budget.reserve({
    sponsorAgent: principal,
    capabilityId: `mcp.native.${tool}`,
    estimatedUnits: 1,
    idempotencyKey: requestId,
  });
  if (!reservation.allowed) {
    return { ok: false, error: 'budget_exhausted', served_by: `demo-mcp:${tool} (native)` };
  }
  try {
    const out = await run();
    if (out && typeof out === 'object' && (out as { ok?: boolean }).ok === false) {
      await budget.release(reservation.reservationId!); // data-layer denial — don't charge
    } else {
      await budget.commit(reservation.reservationId!, 1); // served — charge one unit
    }
    return out;
  } catch (e) {
    await budget.release(reservation.reservationId!);
    throw e;
  }
}

// GatewayAssertion admission check (spec 288 §4/§6) — verify the edge admitted THESE exact bytes for this
// route. Admission proof ONLY (the route's own authority still runs). Advisory unless
// DEMO_REQUIRE_GATEWAY_ASSERTION (the route-lockdown lever: only edge-admitted requests pass). Returns a
// 401 Response to short-circuit on failure, or null to proceed. `rawText` is the exact received body.
async function checkGatewayAssertion(
  c: { env: Env; req: { header(name: string): string | undefined }; json(o: unknown, s?: number): Response },
  rawText: string,
  expected: { path: string; operationId: string },
): Promise<Response | null> {
  const gaToken = c.req.header('x-agentic-gateway-assertion');
  const gaSecret = c.env.GATEWAY_ASSERTION_SECRET?.trim();
  const gaRequired = c.env.DEMO_REQUIRE_GATEWAY_ASSERTION === 'true';
  if (gaRequired && (!gaToken || !gaSecret)) return c.json({ error: 'gateway_assertion_required' }, 401);
  if (gaToken && gaSecret) {
    try {
      const { assertion, signature } = decodeGatewayAssertionToken(gaToken);
      const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawText));
      const digest = 'sha256:' + [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const verdict = await verifyGatewayAssertion({
        assertion,
        expected: { aud: 'urn:agentic:edge', method: 'POST', path: expected.path, bodyDigest: digest, operationId: expected.operationId },
        verify: createHmacGatewayAssertionVerifier(gaSecret, signature),
      });
      if (!verdict.ok && gaRequired) return c.json({ error: 'gateway_assertion_invalid', reason: verdict.reason }, 401);
    } catch (e) {
      if (gaRequired) return c.json({ error: 'gateway_assertion_invalid', detail: e instanceof Error ? e.message : String(e) }, 401);
    }
  }
  return null;
}

// spec 278 — gate a SIMPLE vault op (profile read, generic record read/write — paths that
// don't mint a one-time DecryptGrant) on the per-person binding + vault-key authorization.
// No binding ⇒ fail closed (VKB-D1). Returns the per-person Vault on allow.
async function authorizePersonVaultOp(
  env: Env,
  owner: string,
  resource: string,
  op: 'read' | 'write',
  classification: string,
): Promise<{ ok: true; pv: PersonVault } | { ok: false; error: 'vault_key_unauthorized' }> {
  const pv = await resolvePersonVault(env, owner);
  if (!pv) {
    console.warn(`[vault-key] unauthorized: NO BINDING owner=${owner} resource=${resource} op=${op}`);
    return { ok: false, error: 'vault_key_unauthorized' };
  }
  const verdict = await verifyVaultKeyAuthorization({
    verifier: buildVaultKeyVerifier(env),
    authorization: pv.authorization,
    binding: pv.binding,
    request: { vaultId: pv.binding.vaultId, ownerPersonSA: owner, serverId: VAULT_SERVER_ID, resource, op, classification },
  });
  if (!verdict.ok) {
    console.warn(`[vault-key] unauthorized: owner=${owner} resource=${resource} op=${op} reason=${verdict.reason} allowed=${JSON.stringify(pv.binding.allowedResources)}`);
    return { ok: false, error: 'vault_key_unauthorized' };
  }
  return { ok: true, pv };
}

export interface Env extends AkcsEnv {
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
  /**
   * spec 303 W2 — signs verification receipts ('demo-hmac' over the canonical
   * receiptHash). Demo-grade symmetric signer; unset ⇒ unsigned
   * (integrity-only) receipts. Production target: service-SA KMS EIP-712.
   */
  VERIFICATION_RECEIPT_SECRET?: string;
  /** spec 303 — Cloud KMS secp256k1 cryptoKeyVersion for the ASYMMETRIC
   *  receipt signer (EIP-191 over receiptHash, ecrecover-verifiable offline).
   *  Takes precedence over the demo-hmac secret; needs GCP_SERVICE_ACCOUNT_JSON. */
  VERIFICATION_RECEIPT_KMS_KEY?: string;

  // ─── Per-person vault key custody (spec 278 P4) ───────────────────────
  /**
   * Service-account JSON for the GCP Cloud KMS project that holds the per-person KEKs.
   * Each person's vault is wrapped under THAT person's KEK (resolved from their
   * VaultKeyBinding via `selectVaultKeyProvider`); there is NO global vault master key
   * (VKB-D1). Required to wield any binding's KEK. (The legacy `VAULT_MASTER_KEY` +
   * `A2A_ALLOW_LOCAL_ENVELOPE_KEY` global-key path was removed in spec 278 P4.)
   */
  GCP_SERVICE_ACCOUNT_JSON?: string;
  /** GCP Cloud KMS location + key ring for on-demand KEK provisioning (POST /custody/vault-key/provision).
   *  Default us-east1 / vault-keks. project_id + runtime SA are read from GCP_SERVICE_ACCOUNT_JSON. */
  GCP_KEK_LOCATION?: string;
  GCP_KEK_KEYRING?: string;
  /** DEV ONLY (refused in production): derive per-person KEKs locally instead of GCP Cloud KMS so the
   *  vault ceremony + reads/writes work on a local stack. See vault-key.ts `localKekEnabled`. */
  DEMO_VAULT_LOCAL_KEK_SECRET?: string;
  /** Gates POST /custody/vault-key/provision (on-demand KEK creation — wields the admin credential).
   *  Fail-closed: the route 404s unless this is 'true'. The demo sets it; production leaves it unset
   *  and provisions out of band. */
  DEMO_VAULT_PROVISION_ENABLED?: string;
  /** mcp-provision-unauth-prod: testnet-only skip of the owner-control proof on the provision route.
   *  Fail-closed by default: unset ⇒ the caller must sign an ERC-1271 proof of control over `owner`
   *  (freshness-bound) before any KEK is created. The live demo sets it while its client callers are
   *  updated to sign the challenge; a real deployment leaves it unset. Allowlisted in check-fail-open-knobs.ts. */
  DEMO_VAULT_PROVISION_SKIP_PROOF?: string;
  /** This server's authorized delegate, advertised by GET /custody/vault-key/server-info so the
   *  ceremony auto-fills it. Default is a placeholder (the read verifier doesn't pin it yet). */
  VAULT_KEY_SERVER_DELEGATE?: string;

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
  /**
   * Spec 287 — enables the PUBLIC NATIVE MCP ingress (`POST /mcp/native`) that requires a per-call
   * `AgenticInvocationProofV1` (session-key proof-of-possession over the exact call). Fail-closed: the
   * route 404s unless this is exactly 'true'. Distinct from the OAuth `/mcp` ingress (grant-bundle model,
   * no per-call signature) and the internal A2A `/tools/*` path (service-MAC). Requires
   * `UNIVERSAL_SIGNATURE_VALIDATOR` to verify the proof signature.
   */
  DEMO_NATIVE_MCP_ENABLED?: string;

  // ─── Stage-3 per-SA hard budget (spec 290 §8) ─────────────────────────
  /**
   * The SmartAgentBudgetDO namespace — the authoritative per-Smart-Agent hard-budget store, enforced
   * on the native path AFTER authority (keyed by the verified principal = sponsorAgent). Additive to
   * the on-chain enforcers, never a replacement (ADR-0041). Optional: when unbound, the native path
   * skips the Stage-3 budget (authority + JTI still apply).
   */
  SA_BUDGET?: BudgetDoNamespace;
  /** Per-Smart-Agent hard-budget unit cap (default 1000). */
  SA_BUDGET_LIMIT_UNITS?: string;

  // ─── Edge admission proof (spec 288 §4) ───────────────────────────────
  /** Shared HMAC secret for verifying the edge's GatewayAssertion (same value as demo-edge). When set,
   *  the native path verifies the assertion if present (advisory). Unset ⇒ no verification. */
  GATEWAY_ASSERTION_SECRET?: string;
  /** When 'true', the native path REQUIRES a valid GatewayAssertion — only edge-admitted requests pass
   *  (the route-lockdown precursor). Default unset ⇒ advisory (direct callers still work). */
  DEMO_REQUIRE_GATEWAY_ASSERTION?: string;
}

// spec 289 §5 — the resilient chain-read authority port (W1 revocation + W2 acceptance). Built once per
// isolate over a single viem provider (the configured RPC); add more providers for multi-RPC divergence
// later. Returns undefined when it can't be built (no RPC / USV) so the verify config falls back to the
// inline single-client reads. Memoized: the breaker/freshness state persists across requests in the isolate.
// Spec 290 §6 Stage-2 — module-scoped (per-isolate) SOFT rate limiter, keyed on the verified
// principal+capability. Memoized so buckets persist across requests in an isolate (a per-call limiter
// would never throttle). In-memory is per-isolate (not cross-isolate-durable) — fine for a soft traffic
// limit; the cross-isolate HARD budget is the Stage-3 SmartAgentBudgetDO. 120 verified calls / 60s.
let _stage2Limiter: SoftRateLimiter | undefined;
function stage2RateLimiter(): SoftRateLimiter {
  if (!_stage2Limiter) {
    _stage2Limiter = createMemorySoftRateLimiter({ limits: { verified: { windowMs: 60_000, limit: 120 } } });
  }
  return _stage2Limiter;
}

/** sha256(signer:digest:signature) — the durable signature-verdict cache key. Including the signature
 *  means a different/forged signature for the same digest MISSES and is re-verified on-chain. */
async function sigVerdictKey(input: SignatureInput): Promise<string> {
  const data = new TextEncoder().encode(
    `${input.signer.toLowerCase()}:${input.digest.toLowerCase()}:${input.signature.toLowerCase()}`,
  );
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Wrap the resilient chain reader with a DURABLE, cross-isolate cache of the IMMUTABLE positive signature
 * verdict (D1 migration 0012). Mirrors the vault-key hash-pin: a valid ERC-1271/6492/ECDSA signature over
 * a fixed delegation digest never becomes invalid, and a deployed SA never un-deploys — so a
 * `valid && deployed` verdict is checked on-chain ONCE and cached forever, removing the per-op RPC that
 * (under Cloudflare isolate churn) intermittently rate-limited and made valid vault reads flake.
 *
 * ONLY `verifySmartAgentSignature` positive+deployed verdicts are cached (monotonic; a negative or
 * counterfactual verdict re-checks). Revocation + acceptance PASS THROUGH unchanged — they MUST stay
 * fresh (ADR-0013 revocation-freshness invariant; a durable "not revoked" would never expire).
 */
function withDurableSigCache(env: Env, base: ChainAuthorityReader): ChainAuthorityReader {
  const chainId = Number(env.CHAIN_ID);
  return {
    isDelegationRevoked: (hash, risk) => base.isDelegationRevoked(hash, risk),
    isSessionDelegationAccepted: (principal, hash, risk) => base.isSessionDelegationAccepted(principal, hash, risk),
    async verifySmartAgentSignature(input, risk) {
      const key = await sigVerdictKey(input);
      try {
        if (await hasSigVerdict(env.DB, key)) {
          return {
            valid: true,
            deployed: true,
            // source must NOT start with 'fail-closed' (token.ts treats that as unconfirmable).
            evidence: { chainId, blockNumber: 0n, blockHash: `0x${'0'.repeat(64)}`, observedAt: 0, source: 'durable-cache:demo-mcp-sig' },
          };
        }
      } catch { /* cache-read failure → fall through to the real on-chain verify */ }
      const r = await base.verifySmartAgentSignature(input, risk);
      if (r.valid && r.deployed) {
        try { await putSigVerdict(env.DB, key, chainId); } catch { /* best-effort cache write */ }
      }
      return r;
    },
  };
}

let _chainReader: ChainAuthorityReader | undefined;
let _chainReaderTried = false;
function chainAuthorityReader(env: Env): ChainAuthorityReader | undefined {
  if (_chainReaderTried) return _chainReader;
  _chainReaderTried = true;
  const usv = env.UNIVERSAL_SIGNATURE_VALIDATOR?.trim();
  if (!env.RPC_URL || !usv) return undefined;
  const provider = createViemChainProvider({
    source: 'base-sepolia-rpc',
    delegationManager: env.DELEGATION_MANAGER as Address,
    universalSignatureValidator: usv as Address,
    rpcUrl: env.RPC_URL,
  });
  _chainReader = withDurableSigCache(env, createChainAuthorityReader({ chainId: Number(env.CHAIN_ID), providers: [provider] }));
  return _chainReader;
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
    // spec 289 §5 (W1+W2+W3) — route the revocation + acceptance + SIGNATURE reads through the resilient
    // chain-state port (per-provider circuit-breaker + timeout + the revocation bounded-freshness/monotonic
    // invariant + divergence evidence) instead of the inline single-client reads. Falls back to inline when
    // the reader can't be built (no RPC/USV). The signature reader validates via the UniversalSignatureValidator
    // (ECDSA/1271/6492) and surfaces `deployed`; token.ts keeps the requireDeployed policy (true here — the
    // demo deploys SAs before delegating, so an undeployed delegator is correctly rejected fail-closed).
    chainRevocationReader: chainAuthorityReader(env),
    chainAcceptanceReader: chainAuthorityReader(env),
    chainSignatureReader: chainAuthorityReader(env),
    // spec 290 §6 Stage-2 — post-verify soft rate limit, keyed on the verified principal/sponsor.
    stage2RateLimiter: stage2RateLimiter(),
    rateLimitProfileId: 'verified',
    rateLimitSecret: 'demo-mcp-stage2', // only obscures the opaque bucket key in logs (§9); not a secret-grade gate
  };
}

// DEL-001 (spec 270 v4) — the verify config for a vault call, ENFORCING the session-key↔delegator
// binding when the request is client-minted. demo-a2a sets `enforceBinding` ONLY on the forwarded
// client-mint path (per-source binding); the persona/admin path leaves it false, so those tokens
// (no leaf) keep verifying under the legacy config. The signal rides the service-MAC-authenticated
// body, so it's unforgeable. When enforcing, we ALSO switch to the UniversalSignatureValidator so the
// leaf validates under any connection strategy. (With the spec-289 §5 W3 signature reader wired in
// baseConfig, the leaf signature routes through the resilient port — which validates via the same USV and
// enforces `requireDeployed`; this `universalSignatureValidator` field remains the inline fallback for when
// the reader can't be built.) A `""`/unset USV is treated as undefined (wrangler binds empty strings).
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

// CRIT-2 W3 (audit 2026-07-13) — the a2a-task-do SERVER-SIDE seams (orchestrate + FR-3.4 entitlement-VC)
// have no browser to sign a DEL-001 self-leaf, so they CLIENT-MINT with a DO-held KMS session key + a
// per-call AgenticInvocationProofV1 (proof-of-possession), forwarded over the MAC /tools path. When the
// (MAC-authenticated, unforgeable) body carries an `invocationProof`, verify possession via the spec-287
// requireInvocationProof gate (mirrors /mcp/native) layered on the route's base config — NO server-mint.
// Absent ⇒ the route's existing config is unchanged (fully backward-compatible). Fail-closed: proof
// requested but no UniversalSignatureValidator ⇒ throw (mapped to 500, rejecting the call).
function withProof(env: Env, base: McpResourceVerifyConfig, invocationProof: AgenticInvocationProofV1 | undefined): McpResourceVerifyConfig {
  if (!invocationProof) return base;
  const usv = env.UNIVERSAL_SIGNATURE_VALIDATOR?.trim();
  if (!usv) throw new Error('invocation-proof verification requested but UNIVERSAL_SIGNATURE_VALIDATOR is unset (fail-closed)');
  return { ...base, requireInvocationProof: true, universalSignatureValidator: usv as Address };
}

// Variables stashed on the Hono context by the service-mac middleware
// so the tool route handlers don't need to re-read the body (Hono
// consumes the stream on first read).
interface Variables {
  parsedBody: { token?: string; args?: Record<string, unknown>; enforceBinding?: boolean; invocationProof?: AgenticInvocationProofV1 };
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
  // agentic-kms: the MAC key is derived inside AKCS (ap-mac-v1) — no shared A2A_MAC_SECRET needed.
  if (!c.env.A2A_MAC_SECRET && !isAgenticKms(c.env)) {
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
  const provider = isAgenticKms(c.env)
    ? buildMacProvider(c.env.MCP_AUDIENCE, { backend: 'agentic-kms', agenticKms: agenticKmsConfig(c.env) })
    : buildMacProvider(c.env.MCP_AUDIENCE, {
        backend: 'local-aes',
        // Present here by the guard above (unset + not agentic-kms returned early).
        config: { sessionSecretHex: c.env.A2A_MAC_SECRET as string },
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
    withProof(c.env, baseConfig(c.env), body.invocationProof),
    async ({ principal }) => {
      // Profile lives in the encrypted vault (resource `profile`, pii.low). spec 278:
      // gated on the person's vault-key binding + authorization — no binding ⇒ fail closed.
      const gate = await authorizePersonVaultOp(c.env, principal, RESOURCE_PROFILE, 'read', 'pii.low');
      if (!gate.ok) return { ok: false, error: gate.error, served_by: 'demo-mcp:get_profile' };
      const obj = await gate.pv.vault.read<Profile>({ owner: principal, resource: RESOURCE_PROFILE });
      // Label the owner with its `.agent` name (single-call resolve).
      const owner_name = await resolveAgentName(c.env, principal);
      return { ok: true, profile: obj?.data ?? null, owner_name };
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
    const result = await handler({ token: body.token, args: body.args ?? {}, invocationProof: body.invocationProof } as Parameters<typeof handler>[0] & { invocationProof?: AgenticInvocationProofV1 });
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
    withProof(c.env, baseConfig(c.env), body.invocationProof),
    async ({ principal, args, grants }) => {
      const r = await readSensitive(
        c.env,
        { principal, args, grants, correlationId: getCorrelationId(c), audience: c.env.MCP_AUDIENCE },
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
    const result = await handler({ token: body.token, args: body.args ?? {}, invocationProof: body.invocationProof } as Parameters<typeof handler>[0] & { invocationProof?: AgenticInvocationProofV1 });
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
    withProof(c.env, baseConfig(c.env), body.invocationProof),
    async ({ principal, args, grants }) => {
      const r = await readSensitive(
        c.env,
        { principal, args, grants, correlationId: getCorrelationId(c), audience: c.env.MCP_AUDIENCE },
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
    const result = await handler({ token: body.token, args: body.args ?? {}, invocationProof: body.invocationProof } as Parameters<typeof handler>[0] & { invocationProof?: AgenticInvocationProofV1 });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code, (e as any).reason, e.stack); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

// ─── PUBLIC NATIVE MCP ingress — exact-invocation proof (spec 287) ───────
//
// The third transport (alongside internal A2A `/tools/*` service-MAC and the
// OAuth `/mcp` grant-bundle ingress): a TRULY PUBLIC delegation-token call that
// binds the EXACT arguments via an `AgenticInvocationProofV1` (the session key
// signs an EIP-712 digest over chainId/audience/operation/argsHash/tokenHash/
// requestId/window; verified through the UniversalSignatureValidator + one-shot
// requestId). This closes the gap where the public hop had only the delegation
// token (proves "may call tool", not "is making THIS exact call").
//
// No service-MAC (not internal) and no OAuth bearer (the proof IS the per-call
// authenticity). `requireInvocationProof: true` makes withDelegation fail-closed
// on a missing/invalid/replayed proof. Fail-closed behind DEMO_NATIVE_MCP_ENABLED.
//
// NOTE: the proof binds the handler's argument object — for this route that is
// `{ args: <toolArgs> }` (the call shape below). A client builds the proof with
// `buildInvocationProof({ ..., args: { args: toolArgs } })`.
//
// CORS: browsers (demo-web-pro's Act-6 panels) call this ingress directly AND via the edge — the
// edge forwards Origin and deliberately does not tag dispatched responses, so ACAO must come from
// here. Same posture as the OAuth routes: no cookies, the authority is the delegation token +
// invocation proof in the body. Registered BEFORE the route — Hono dispatches in registration
// order, so the shared OAUTH_CORS_PATHS block (declared later in this file) can't wrap this route.
// (`corsHeaders` is a hoisted function declaration, so calling it from here is safe.)
app.use('/mcp/native', async (c, next) => {
  const origin = c.req.header('Origin') ?? '*';
  if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  await next();
  const merged = new Headers(c.res.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) merged.set(k, v);
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers: merged });
});
app.post('/mcp/native', async (c) => {
  if (c.env.DEMO_NATIVE_MCP_ENABLED !== 'true') return c.json({ error: 'not_found' }, 404);
  const usv = c.env.UNIVERSAL_SIGNATURE_VALIDATOR?.trim();
  if (!usv) return c.json({ error: 'unsupported', detail: 'UNIVERSAL_SIGNATURE_VALIDATOR unset' }, 501);

  // Read the RAW body text (not c.req.json()) so the GatewayAssertion bodyDigest can be recomputed over
  // the exact received bytes (matching the edge's sha256 of the forwarded body).
  const rawText = await c.req.text().catch(() => '');
  const reqBody = (() => {
    try {
      return JSON.parse(rawText) as
        | { token?: string; invocationProof?: AgenticInvocationProofV1; tool?: string; args?: { fields?: string[]; purpose?: string } }
        | null;
    } catch {
      return null;
    }
  })();
  if (!reqBody?.token) return c.json({ error: 'token required' }, 400);
  if (!reqBody.invocationProof) return buildInvalidInvocationProofResponse();

  // GatewayAssertion (spec 288 §4/§6) — admission proof; the full Web3 authority still runs below.
  const gaNative = await checkGatewayAssertion(c, rawText, { path: '/mcp/native', operationId: 'mcp.native' });
  if (gaNative) return gaNative;

  const auditSink = buildAuditSink(c.env);
  const correlationId = getCorrelationId(c);
  const environment =
    typeof process !== 'undefined' && process.env?.NODE_ENV === 'production' ? 'production' : 'development';

  // The public native config: baseConfig + the spec-287 gate + the validator.
  const nativeCfg: McpResourceVerifyConfig = {
    ...baseConfig(c.env),
    requireInvocationProof: true,
    universalSignatureValidator: usv as Address,
  };

  type Args = { args?: { fields?: string[]; purpose?: string } };
  const TOOLS: Record<
    string,
    { classification: typeof GET_PII_CLASSIFICATION; run: (principal: Address, args: Args['args'], grants?: DataScopeGrant[]) => Promise<unknown> }
  > = {
    get_pii: {
      classification: GET_PII_CLASSIFICATION,
      run: async (principal, args, grants) => {
        const r = await readSensitive(
          c.env,
          { principal, args, grants, correlationId, audience: c.env.MCP_AUDIENCE },
          { resource: RESOURCE_PERSON_PII, classification: 'pii.sensitive', toolName: 'get_pii', servedBy: 'demo-mcp:get_pii (native)' },
        );
        if (!r.ok) return r;
        return { ok: true, subject: principal, subject_name: r.subject_name, record: r.record, served_by: 'demo-mcp:get_pii (native)' };
      },
    },
    get_org_sensitive: {
      classification: GET_ORG_SENSITIVE_CLASSIFICATION,
      run: async (principal, args, grants) => {
        const r = await readSensitive(
          c.env,
          { principal, args, grants, correlationId, audience: c.env.MCP_AUDIENCE },
          { resource: RESOURCE_ORG_SENSITIVE, classification: 'regulated.high', toolName: 'get_org_sensitive', servedBy: 'demo-mcp:get_org_sensitive (native)' },
        );
        if (!r.ok) return r;
        return { ok: true, org: principal, org_name: r.subject_name, record: r.record, served_by: 'demo-mcp:get_org_sensitive (native)' };
      },
    },
  };
  const entry = TOOLS[reqBody.tool ?? ''];
  if (!entry) return c.json({ error: 'unknown tool', detail: reqBody.tool ?? null }, 400);

  const handler = withDelegation<Args>(
    nativeCfg,
    async ({ principal, args, grants }) => enforceBudget(c.env, principal, reqBody.tool!, reqBody.invocationProof!.requestId, () => entry.run(principal, args, grants)),
    { toolName: reqBody.tool, classification: entry.classification, auditSink, correlationId, environment },
  );
  try {
    const result = await handler({
      token: reqBody.token,
      invocationProof: reqBody.invocationProof,
      args: reqBody.args ?? {},
    } as Args & { token: string; invocationProof: AgenticInvocationProofV1 });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) {
      // A native-path auth failure is most often a bad/missing/replayed proof —
      // surface the distinct OAuth-style code so a client can re-mint a fresh proof.
      console.error('[demo-mcp native] McpAuthError:', e.code, e.correlationId);
      if (e.code === 'auth-failed') return buildInvalidInvocationProofResponse();
      return c.json({ error: 'auth failed', code: e.code, correlationId: e.correlationId }, 401);
    }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

// ─── Conformant stateless MCP endpoint (spec 293) ────────────────────────
// A standards-conformant MCP 2026-07-28 endpoint built on @agenticprimitives/mcp-protocol, capabilities
// GENERATED from a surface-catalog (no hand-written lists). ADDITIVE — /mcp + /mcp/native are unchanged.
// server/discover + tools/list are public protocol methods; tools/call runs the SAME Web3 pipeline as
// /mcp/native (token + invocation proof + withDelegation + budget). The Web3 authority is the ONE declared
// exception, advertised as the io.agentictrustlabs.authority extension (never an OAuth server).
const DEMO_MCP_CATALOG = defineSurface([
  {
    id: 'get_pii',
    protocol: 'mcp',
    description: "Read a person's sensitive PII for an authorized purpose.",
    inputSchema: { type: 'object', properties: { fields: { type: 'array', items: { type: 'string' } }, purpose: { type: 'string' } } },
    outputSchema: { type: 'object' },
    authorization: { mode: 'agentic-delegation', riskTier: 'high' },
    operations: { rateLimitProfile: 'pii', maxBodyBytes: 262144, timeoutMs: 10000, idempotency: 'safe', cache: 'no-store' },
    mcp: { kind: 'tool', annotations: { title: 'Read PII', readOnlyHint: true } },
    // W4-b audit (spec 338 §8): PUBLIC is correct and DELIBERATE, not an oversight. An external MCP
    // client must be able to SEE this tool to call it legitimately; what protects the data is
    // delegation ∩ entitlement ∩ tool policy ∩ key-release ∩ audit, re-run at the origin — never the
    // tool's absence from a list. Recorded explicitly so a future reader knows it was reviewed.
    publication: { exposure: 'public' },
  },
  {
    id: 'get_org_sensitive',
    protocol: 'mcp',
    description: "Read an organization's sensitive/regulated data for an authorized purpose.",
    inputSchema: { type: 'object', properties: { fields: { type: 'array', items: { type: 'string' } }, purpose: { type: 'string' } } },
    outputSchema: { type: 'object' },
    authorization: { mode: 'agentic-delegation', riskTier: 'critical', onchainAcceptanceRequired: true },
    operations: { rateLimitProfile: 'pii', maxBodyBytes: 262144, timeoutMs: 10000, idempotency: 'safe', cache: 'no-store' },
    mcp: { kind: 'tool', annotations: { title: 'Read org-sensitive', readOnlyHint: true } },
    // W4-b audit: PUBLIC deliberately — see the note on `get_pii`. Discoverability is not access;
    // this tool additionally requires on-chain acceptance (`onchainAcceptanceRequired`).
    publication: { exposure: 'public' },
  },
] satisfies SurfaceDescriptor[]);

const DEMO_AUTHORITY_EXTENSION = authorityExtensionEntry({
  version: '1',
  authorizationModes: ['agentic-delegation', 'invocation-proof'],
  signatureSchemes: ['erc-1271', 'erc-6492', 'ecdsa'],
  delegationTokenVersion: 'v4',
  invocationProofVersion: 'v1',
});

app.post('/mcp/v2', async (c) => {
  if (c.env.DEMO_NATIVE_MCP_ENABLED !== 'true') return c.json({ error: 'not_found' }, 404);
  const usv = c.env.UNIVERSAL_SIGNATURE_VALIDATOR?.trim();
  const rawText = await c.req.text().catch(() => '');
  // Admission (spec 288 §6) — same edge gate as the other MCP ingresses.
  const ga = await checkGatewayAssertion(c, rawText, { path: '/mcp/v2', operationId: 'mcp.v2' });
  if (ga) return ga;

  const parsed = parseJsonRpc(rawText);
  if (!parsed.ok) return c.json(parsed.res as unknown as Record<string, unknown>);
  const req = parsed.req;
  const meta = parseRequestMeta(req.params?._meta as Record<string, unknown> | undefined, c.req.header('mcp-protocol-version'));
  const version = negotiateProtocolVersion(meta.protocolVersion);
  if (!version) {
    return c.json({ jsonrpc: '2.0', id: req.id ?? null, error: { code: RPC_ERROR.INVALID_REQUEST, message: 'unsupported protocol version' } });
  }
  const integrity = checkRequestIntegrity({ method: c.req.header('mcp-method'), name: c.req.header('mcp-name') }, req, { requireMethodHeader: false });
  if (!integrity.ok) {
    return c.json({ jsonrpc: '2.0', id: req.id ?? null, error: { code: RPC_ERROR.INVALID_REQUEST, message: 'request integrity check failed' } });
  }

  const auditSink = buildAuditSink(c.env);
  const correlationId = getCorrelationId(c);
  const environment = typeof process !== 'undefined' && process.env?.NODE_ENV === 'production' ? 'production' : 'development';

  type ToolArgs = { args?: { fields?: string[]; purpose?: string } };
  // LOG THE ERROR, not just that there was one. This handler discarded `info.error`, so a
  // fail-closed misconfiguration surfaced as the word "internal error" with no cause anywhere —
  // the client is told nothing by design, which makes the server log the ONLY place it can be seen.
  const registry = new MethodRegistry({ onError: (info) => console.error('[demo-mcp /mcp/v2]', info.method, info.correlationId, info.error instanceof Error ? `${info.error.name}: ${info.error.message}` : String(info.error)) })
    .register('server/discover', () =>
      buildServerDiscover({
        serverInfo: { name: 'demo-mcp', version: '2' },
        capabilities: buildMcpServerCapabilities(DEMO_MCP_CATALOG),
        extensions: DEMO_AUTHORITY_EXTENSION,
      }) as unknown as Record<string, unknown>,
    )
    .register('tools/list', () => withCacheable(buildMcpToolsList(DEMO_MCP_CATALOG), mcpListCacheHint(DEMO_MCP_CATALOG, 'tool')))
    .register('tools/call', async (params) => {
      if (!usv) throw new RpcError(RPC_ERROR.INTERNAL_ERROR, 'unsupported');
      const name = typeof params?.name === 'string' ? params.name : '';
      if (!DEMO_MCP_CATALOG.get(name)) throw new RpcError(RPC_ERROR.METHOD_NOT_FOUND, 'unknown tool');
      const a = (params?.arguments ?? {}) as { token?: string; invocationProof?: AgenticInvocationProofV1; fields?: string[]; purpose?: string };
      if (!a.token) throw new RpcError(RPC_ERROR.INVALID_PARAMS, 'token required');
      if (!a.invocationProof) throw new RpcError(RPC_ERROR.INVALID_PARAMS, 'invocation proof required');
      const spec =
        name === 'get_org_sensitive'
          ? { resource: RESOURCE_ORG_SENSITIVE, classification: 'regulated.high' as const, toolName: 'get_org_sensitive', servedBy: 'demo-mcp:get_org_sensitive (mcp/v2)' }
          : { resource: RESOURCE_PERSON_PII, classification: 'pii.sensitive' as const, toolName: 'get_pii', servedBy: 'demo-mcp:get_pii (mcp/v2)' };
      const classification = name === 'get_org_sensitive' ? GET_ORG_SENSITIVE_CLASSIFICATION : GET_PII_CLASSIFICATION;
      // spec 303 W2 — mint a verification receipt at the wrapper's terminal
      // decision (allow AND deny); the holder carries the public receipt back
      // into the response `_meta.ap_receipt`.
      const { receipts, holder } = buildReceiptsConfig(c.env, { correlationId });
      const nativeCfg: McpResourceVerifyConfig = { ...baseConfig(c.env), requireInvocationProof: true, universalSignatureValidator: usv as Address, receipts };
      const handler = withDelegation<ToolArgs>(
        nativeCfg,
        async ({ principal, args, grants }) =>
          enforceBudget(c.env, principal, name, a.invocationProof!.requestId, () =>
            readSensitive(c.env, { principal, args, grants, correlationId, audience: c.env.MCP_AUDIENCE }, spec),
          ),
        { toolName: name, classification, auditSink, correlationId, environment },
      );
      let out: { ok?: boolean; record?: unknown; subject_name?: string; error?: string };
      try {
        out = (await handler({ token: a.token, invocationProof: a.invocationProof, args: { fields: a.fields, purpose: a.purpose } } as ToolArgs & {
          token: string;
          invocationProof: AgenticInvocationProofV1;
        })) as typeof out;
      } catch (e) {
        if (e instanceof McpAuthError) throw new RpcError(RPC_ERROR.INVALID_PARAMS, 'authorization failed');
        throw new RpcError(RPC_ERROR.INTERNAL_ERROR, 'internal error');
      }
      if (out.ok === false) throw new RpcError(RPC_ERROR.INVALID_PARAMS, out.error ?? 'denied');
      const result = structuredResult({ tool: name, subject_name: out.subject_name ?? null, record: out.record ?? null }) as unknown as Record<string, unknown>;
      // spec 303 W2 — the caller retains the public receipt independently of
      // this host (the article's point). Commitment-only: safe to return.
      if (holder.receipt) result._meta = { ...(result._meta as Record<string, unknown> | undefined), ap_receipt: holder.receipt };
      return result;
    });

  const res = await registry.dispatch(req, { meta, protocolVersion: version, raw: rawText, correlationId });
  return res === null ? c.body(null, 204) : c.json(res as unknown as Record<string, unknown>);
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
      withProof(c.env, vaultConfig(c.env, body.enforceBinding), body.invocationProof),
      async ({ principal, args, recordScopes }) => {
        const recordType = args?.recordType;
        if (!recordType) return { ok: false, error: 'recordType required' };
        const resource = `${VAULT_RECORD_PREFIX}${recordType}`;
        // spec 317 §3.2: per-delegation record scope FIRST (narrows the binding), then the binding gate.
        if (!recordScopeAllows(recordScopes, resource, 'read')) {
          return { ok: false, error: 'record_scope_denied', served_by: 'demo-mcp:get_vault_record' };
        }
        const gate = await authorizePersonVaultOp(c.env, principal, resource, 'read', 'internal');
        if (!gate.ok) return { ok: false, error: gate.error, served_by: 'demo-mcp:get_vault_record' };
        const obj = await gate.pv.vault.read({ owner: principal, resource });
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
    const result = await handler({ token: body.token, args: body.args ?? {}, invocationProof: body.invocationProof } as Parameters<typeof handler>[0] & { invocationProof?: AgenticInvocationProofV1 });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code, (e as any).reason, e.stack); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

// VL-W2 — batch multi-get: read MANY of one owner's records in ONE round-trip (collapses N cross-worker
// calls + N per-op binding resolves into 1). Same classification/gates as get_vault_record.
declareTool({ name: 'get_vault_records' }, GET_VAULT_RECORD_CLASSIFICATION);

app.post('/tools/get_vault_records', async (c) => {
  const body = c.get('parsedBody');
  if (!body?.token) return c.json({ error: 'token required' }, 400);
  const auditSink = buildAuditSink(c.env);
  type Args = { args?: { recordTypes?: string[] } };
  try {
    const handler = withDelegation<Args>(
      withProof(c.env, vaultConfig(c.env, body.enforceBinding), body.invocationProof),
      async ({ principal, args, recordScopes }) => {
        const recordTypes = Array.isArray(args?.recordTypes) ? args!.recordTypes!.filter((r): r is string => typeof r === 'string') : [];
        if (recordTypes.length === 0) return { ok: true, owner: principal, records: {}, served_by: 'demo-mcp:get_vault_records' };
        // Resolve the per-person vault ONCE for the whole batch (one binding read + one KEK provider),
        // then verify + read each record against it. ADR-0013: an owner-level vault-key auth failure fails
        // the WHOLE batch (never a partial silent-empty); a per-record DELEGATION-scope denial is a legit
        // omission; a decrypt failure throws (→ 500, the client retries). VL-W3's DEK cache makes the
        // repeat batch (re-hydration) skip KMS.
        const pv = await resolvePersonVault(c.env, principal);
        if (!pv) return { ok: false, error: 'vault_key_unauthorized', served_by: 'demo-mcp:get_vault_records' };
        const verifier = buildVaultKeyVerifier(c.env);
        const records: Record<string, unknown> = {};
        let authFailed = false;
        await Promise.all(recordTypes.map(async (rt) => {
          const resource = `${VAULT_RECORD_PREFIX}${rt}`;
          if (!recordScopeAllows(recordScopes, resource, 'read')) return; // scoped-out → omit (legit)
          const verdict = await verifyVaultKeyAuthorization({
            verifier, authorization: pv.authorization, binding: pv.binding,
            request: { vaultId: pv.binding.vaultId, ownerPersonSA: principal, serverId: VAULT_SERVER_ID, resource, op: 'read', classification: 'internal' },
          });
          if (!verdict.ok) { authFailed = true; return; } // do NOT read; fail the whole batch below
          const obj = await pv.vault.read({ owner: principal, resource });
          records[rt] = obj?.data ?? null;
        }));
        if (authFailed) return { ok: false, error: 'vault_key_unauthorized', served_by: 'demo-mcp:get_vault_records' };
        return { ok: true, owner: principal, records, served_by: 'demo-mcp:get_vault_records' };
      },
      {
        toolName: 'get_vault_records',
        classification: GET_VAULT_RECORD_CLASSIFICATION,
        auditSink,
        correlationId: getCorrelationId(c),
        environment: (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production' ? 'production' : 'development'),
      },
    );
    const result = await handler({ token: body.token, args: body.args ?? {}, invocationProof: body.invocationProof } as Parameters<typeof handler>[0] & { invocationProof?: AgenticInvocationProofV1 });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
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
      withProof(c.env, vaultConfig(c.env, body.enforceBinding), body.invocationProof),
      async ({ principal, args, recordScopes }) => {
        const recordType = args?.recordType;
        if (!recordType) return { ok: false, error: 'recordType required' };
        const resource = `${VAULT_RECORD_PREFIX}${recordType}`;
        // `data === null` is a soft-delete (tombstone) by contract — a DISTINCT op for the record-scope
        // gate, so a write-only delegate cannot censor records (spec 317 §3.2 / audit F1).
        const isTombstone = (args?.data ?? null) === null;
        // spec 317 §3.2: per-delegation record scope FIRST (narrows the binding), then the binding gate.
        if (!recordScopeAllows(recordScopes, resource, isTombstone ? 'delete' : 'write')) {
          return { ok: false, error: 'record_scope_denied', served_by: 'demo-mcp:set_vault_record' };
        }
        // spec 278 write gate: sealing requires op:'write' on the person's vault-key authorization
        // (the binding has no separate delete op; the finer write/delete split is the record-scope gate's).
        const gate = await authorizePersonVaultOp(c.env, principal, resource, 'write', 'internal');
        if (!gate.ok) return { ok: false, error: gate.error, served_by: 'demo-mcp:set_vault_record' };
        await gate.pv.vault.write({ owner: principal, resource, data: args?.data ?? null });
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
    const result = await handler({ token: body.token, args: body.args ?? {}, invocationProof: body.invocationProof } as Parameters<typeof handler>[0] & { invocationProof?: AgenticInvocationProofV1 });
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
      withProof(c.env, vaultConfig(c.env, body.enforceBinding), body.invocationProof),
      async ({ principal, recordScopes }) => {
        // spec 278: listing the owner's own records still requires the vault-key binding
        // (the listing comes from the per-person-KEK vault). `vault:` prefix → 'internal'.
        const gate = await authorizePersonVaultOp(c.env, principal, VAULT_RECORD_PREFIX, 'read', 'internal');
        if (!gate.ok) return { ok: false, error: gate.error, served_by: 'demo-mcp:list_vault_record' };
        // Map the vault refs back to the established { record_type, updated_at } shape.
        const refs = await gate.pv.vault.list(principal);
        const records = refs
          .filter((r) => r.resource.startsWith(VAULT_RECORD_PREFIX))
          // spec 317 §3.2: a record-scoped delegation only ENUMERATES record types it may READ, so a
          // write-only delivery delegate lists nothing (no leakage of which records exist). No caveat ⇒
          // unchanged (recordScopeAllows returns true).
          .filter((r) => recordScopeAllows(recordScopes, r.resource, 'read'))
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
    const result = await handler({ token: body.token, args: body.args ?? {}, invocationProof: body.invocationProof } as Parameters<typeof handler>[0] & { invocationProof?: AgenticInvocationProofV1 });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code, (e as any).reason, e.stack); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

// ─── Cross-principal ENTITLEMENTS (spec 277) — org → member (ported from impact-mcp) ─────────────
//
// An ORG (issuer) grants a MEMBER (a different SA that does NOT custody the org) scoped read access
// to the org's vault. Access is gated SOLELY by the entitlement, never by custody/stewardship:
//   • issue/revoke/list  — the ORG presents its own authority (token principal == the org) to mint,
//     revoke, and list grants in `entitlements_issued`.
//   • manage_entitlement_group — D2: the group OWNER (e.g. an Alliance SA) maintains the roster of
//     member SAs that count as readers of any grant issued to `group:<groupId>`.
//   • get_entitled_record — the MEMBER presents THEIR OWN session delegation (token principal == the
//     member = the entitlement's actor), names the org as `owner`, and reads iff a matching, granted,
//     unexpired grant exists. demo-mcp wields the OWNER's KEK (the org's own vault-key binding) to
//     decrypt; the member never holds the org's key.

const ENTITLEMENT_ADMIN_CLASSIFICATION = {
  '@sa-tool': 'delegation-verified',
  '@sa-auth': 'session-token',
  '@sa-risk-tier': 'medium',
} as const;
const ENTITLED_READ_CLASSIFICATION = {
  '@sa-tool': 'delegation-verified',
  '@sa-auth': 'session-token',
  '@sa-risk-tier': 'low',
} as const;
declareTool({ name: 'issue_org_entitlement' }, ENTITLEMENT_ADMIN_CLASSIFICATION);
declareTool({ name: 'revoke_org_entitlement' }, ENTITLEMENT_ADMIN_CLASSIFICATION);
declareTool({ name: 'list_org_entitlements' }, ENTITLED_READ_CLASSIFICATION);
declareTool({ name: 'get_entitled_record' }, ENTITLED_READ_CLASSIFICATION);
declareTool({ name: 'manage_entitlement_group' }, ENTITLEMENT_ADMIN_CLASSIFICATION);

/** A MEMBER reads an ORG's vault record, gated by an org-issued entitlement (NOT custody). The
 *  owner's vault-key binding authorizes this host to wield the owner KEK; the entitlement authorizes
 *  WHO (the actor) + WHICH fields. */
async function readEntitledRecord(
  env: Env,
  ctx: { actor: string; owner: string; recordType: string; fields?: string[]; purpose?: string; audience: string },
): Promise<{ ok: true; data: unknown; allowedFields: string[] | null } | { ok: false; error: string; reason?: string }> {
  const resource = `${VAULT_RECORD_PREFIX}${ctx.recordType}`;
  const gate = await authorizePersonVaultOp(env, ctx.owner, resource, 'read', 'internal');
  if (!gate.ok) return { ok: false, error: gate.error };
  const decision = await ledgerEntitlementResolver(env).resolve({
    actor: ctx.actor, principal: ctx.owner, audience: ctx.audience, resource, action: 'read',
    fields: ctx.fields, purpose: ctx.purpose, classification: 'internal', at: new Date(),
  });
  if (decision.decision === 'deny') return { ok: false, error: 'entitlement_denied', reason: decision.reason };
  const obj = await gate.pv.vault.read({ owner: ctx.owner, resource, fields: decision.allowedFields });
  return { ok: true, data: obj?.data ?? null, allowedFields: decision.allowedFields ?? null };
}

app.post('/tools/issue_org_entitlement', async (c) => {
  const body = c.get('parsedBody');
  if (!body?.token) return c.json({ error: 'token required' }, 400);
  const auditSink = buildAuditSink(c.env);
  type Args = { args?: { subject?: string; subjectGroup?: string; recordType?: string; fields?: string[]; actions?: string[]; classificationCeiling?: string; purpose?: string; ttlSeconds?: number } };
  try {
    const handler = withDelegation<Args>(
      withProof(c.env, vaultConfig(c.env, body.enforceBinding), body.invocationProof),
      async ({ principal, args }) => {
        const org = principal; // the issuer — recovered from the org's presented (stewardship) authority
        const recordType = args?.recordType;
        if (!recordType) return { ok: false, error: 'recordType required' };
        // D2: issue to a subjectGroup (group-conferred) OR a concrete member SA. Group grants store
        // actor = 'group:<id>'; the resolver matches any reader in that group's roster.
        const subjectGroup = typeof args?.subjectGroup === 'string' && args.subjectGroup.trim() ? args.subjectGroup.trim().toLowerCase() : undefined;
        let subject: string, actorKey: string;
        if (subjectGroup) {
          subject = `group:${subjectGroup}`; actorKey = subject;
        } else {
          const s = args?.subject;
          if (!s || !/^0x[0-9a-fA-F]{40}$/.test(s)) return { ok: false, error: 'subject (member 0x address) or subjectGroup required' };
          if (s.toLowerCase() === org.toLowerCase()) return { ok: false, error: 'subject must be a different agent than the org' };
          subject = s; actorKey = s.toLowerCase();
        }
        const resource = `${VAULT_RECORD_PREFIX}${recordType}`;
        const id = `urn:ap:entitlement:${crypto.randomUUID()}`;
        const validFromIso = new Date().toISOString();
        const ttl = typeof args?.ttlSeconds === 'number' && args.ttlSeconds > 0 ? args.ttlSeconds : undefined;
        const validUntilIso = ttl ? new Date(Date.now() + ttl * 1000).toISOString() : undefined;
        const actions = (Array.isArray(args?.actions) && args!.actions.length ? args!.actions : ['read']) as EntitlementAction[];
        const fields = Array.isArray(args?.fields) && args!.fields.length ? args!.fields : undefined;
        const credential = buildOrgEntitlement({
          issuer: org, subject, audience: c.env.MCP_AUDIENCE, resource, actions, fields,
          classificationCeiling: (args?.classificationCeiling as EntitlementClassification) ?? 'internal',
          purpose: typeof args?.purpose === 'string' ? args.purpose : undefined,
          validFromIso, validUntilIso, id,
        });
        await c.env.DB.prepare(
          `INSERT INTO entitlements_issued (id, principal, actor, resource, audience, credential, issued_by, valid_until, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'granted', ?)`,
        ).bind(id, org.toLowerCase(), actorKey, resource, c.env.MCP_AUDIENCE, JSON.stringify(credential), org.toLowerCase(), validUntilIso ?? null, validFromIso).run();
        return { ok: true, id, principal: org, subject, ...(subjectGroup ? { subjectGroup } : {}), resource, valid_until: validUntilIso ?? null, served_by: 'demo-mcp:issue_org_entitlement' };
      },
      {
        toolName: 'issue_org_entitlement',
        classification: ENTITLEMENT_ADMIN_CLASSIFICATION,
        auditSink,
        correlationId: getCorrelationId(c),
        environment: (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'
          ? 'production'
          : 'development'),
      },
    );
    const result = await handler({ token: body.token, args: body.args ?? {}, invocationProof: body.invocationProof } as Parameters<typeof handler>[0] & { invocationProof?: AgenticInvocationProofV1 });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code, (e as any).reason, e.stack); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

app.post('/tools/revoke_org_entitlement', async (c) => {
  const body = c.get('parsedBody');
  if (!body?.token) return c.json({ error: 'token required' }, 400);
  const auditSink = buildAuditSink(c.env);
  type Args = { args?: { id?: string } };
  try {
    const handler = withDelegation<Args>(
      withProof(c.env, vaultConfig(c.env, body.enforceBinding), body.invocationProof),
      async ({ principal, args }) => {
        const id = args?.id;
        if (!id) return { ok: false, error: 'id required' };
        // Only the issuing org may revoke its own grant (principal-scoped UPDATE).
        const res = await c.env.DB.prepare(
          `UPDATE entitlements_issued SET status = 'revoked' WHERE id = ? AND principal = ? AND status = 'granted'`,
        ).bind(id, principal.toLowerCase()).run();
        const revoked = (res.meta?.changes ?? 0) > 0;
        return { ok: true, id, revoked, served_by: 'demo-mcp:revoke_org_entitlement' };
      },
      {
        toolName: 'revoke_org_entitlement',
        classification: ENTITLEMENT_ADMIN_CLASSIFICATION,
        auditSink,
        correlationId: getCorrelationId(c),
        environment: (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'
          ? 'production'
          : 'development'),
      },
    );
    const result = await handler({ token: body.token, args: body.args ?? {}, invocationProof: body.invocationProof } as Parameters<typeof handler>[0] & { invocationProof?: AgenticInvocationProofV1 });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code, (e as any).reason, e.stack); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

app.post('/tools/list_org_entitlements', async (c) => {
  const body = c.get('parsedBody');
  if (!body?.token) return c.json({ error: 'token required' }, 400);
  const auditSink = buildAuditSink(c.env);
  type Args = { args?: Record<string, unknown> };
  try {
    const handler = withDelegation<Args>(
      withProof(c.env, vaultConfig(c.env, body.enforceBinding), body.invocationProof),
      async ({ principal }) => {
        const rows = await c.env.DB.prepare(
          `SELECT id, actor, resource, valid_until, status, created_at FROM entitlements_issued WHERE principal = ? ORDER BY created_at DESC LIMIT 200`,
        ).bind(principal.toLowerCase()).all<{ id: string; actor: string; resource: string; valid_until: string | null; status: string; created_at: string }>();
        const entitlements = (rows.results ?? []).map((r) => ({
          id: r.id, member: r.actor, resource: r.resource,
          recordType: r.resource.startsWith(VAULT_RECORD_PREFIX) ? r.resource.slice(VAULT_RECORD_PREFIX.length) : r.resource,
          validUntil: r.valid_until, status: r.status, createdAt: r.created_at,
        }));
        return { ok: true, principal, entitlements, served_by: 'demo-mcp:list_org_entitlements' };
      },
      {
        toolName: 'list_org_entitlements',
        classification: ENTITLED_READ_CLASSIFICATION,
        auditSink,
        correlationId: getCorrelationId(c),
        environment: (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'
          ? 'production'
          : 'development'),
      },
    );
    const result = await handler({ token: body.token, args: body.args ?? {}, invocationProof: body.invocationProof } as Parameters<typeof handler>[0] & { invocationProof?: AgenticInvocationProofV1 });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code, (e as any).reason, e.stack); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

// D2 — maintain a subjectGroup roster (group-conferred entitlements). The token principal is the group
// OWNER (e.g. an Alliance SA); it lists the member SAs that count as readers of any grant issued to
// `group:<groupId>`. op 'set' replaces the owner's roster for the group; 'add' unions.
// NOTE (hardening): group_id is a bare string here; a production build would bind subjectGroup to
// (owner, id) so two owners can't collide on the same group id. Fine for the single-coalition demo.
app.post('/tools/manage_entitlement_group', async (c) => {
  const body = c.get('parsedBody');
  if (!body?.token) return c.json({ error: 'token required' }, 400);
  const auditSink = buildAuditSink(c.env);
  type Args = { args?: { groupId?: string; members?: string[]; op?: 'set' | 'add' } };
  try {
    const handler = withDelegation<Args>(
      withProof(c.env, vaultConfig(c.env, body.enforceBinding), body.invocationProof),
      async ({ principal, args }) => {
        const owner = principal.toLowerCase();
        const groupId = typeof args?.groupId === 'string' ? args.groupId.trim().toLowerCase() : '';
        if (!groupId) return { ok: false, error: 'groupId required' };
        const op = args?.op === 'add' ? 'add' : 'set';
        const members = (Array.isArray(args?.members) ? args!.members : [])
          .map((m) => String(m).toLowerCase())
          .filter((m) => /^0x[0-9a-f]{40}$/.test(m));
        if (op === 'set') {
          await c.env.DB.prepare(`DELETE FROM entitlement_groups WHERE group_id = ? AND owner = ?`).bind(groupId, owner).run();
        }
        const now = new Date().toISOString();
        for (const mem of members) {
          await c.env.DB.prepare(
            `INSERT OR REPLACE INTO entitlement_groups (group_id, member, owner, created_at) VALUES (?, ?, ?, ?)`,
          ).bind(groupId, mem, owner, now).run();
        }
        const cnt = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM entitlement_groups WHERE group_id = ? AND owner = ?`).bind(groupId, owner).first<{ n: number }>();
        return { ok: true, groupId, owner: principal, members: cnt?.n ?? 0, served_by: 'demo-mcp:manage_entitlement_group' };
      },
      {
        toolName: 'manage_entitlement_group',
        classification: ENTITLEMENT_ADMIN_CLASSIFICATION,
        auditSink,
        correlationId: getCorrelationId(c),
        environment: (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'
          ? 'production'
          : 'development'),
      },
    );
    const result = await handler({ token: body.token, args: body.args ?? {}, invocationProof: body.invocationProof } as Parameters<typeof handler>[0] & { invocationProof?: AgenticInvocationProofV1 });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code, (e as any).reason, e.stack); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

app.post('/tools/get_entitled_record', async (c) => {
  const body = c.get('parsedBody');
  if (!body?.token) return c.json({ error: 'token required' }, 400);
  const auditSink = buildAuditSink(c.env);
  type Args = { args?: { owner?: string; recordType?: string; fields?: string[]; purpose?: string } };
  try {
    const handler = withDelegation<Args>(
      withProof(c.env, vaultConfig(c.env, body.enforceBinding), body.invocationProof),
      async ({ principal, args, recordScopes }) => {
        const actor = principal; // the MEMBER reading — recovered from their own session delegation
        const owner = args?.owner;
        const recordType = args?.recordType;
        if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) return { ok: false, error: 'owner (org 0x address) required' };
        if (!recordType) return { ok: false, error: 'recordType required' };
        // spec 317 §3.2: the reader's OWN delegation may carry a record scope — it narrows what this
        // delegation may read even cross-principal. No caveat ⇒ inert (the entitlement is the gate).
        if (!recordScopeAllows(recordScopes, `${VAULT_RECORD_PREFIX}${recordType}`, 'read')) {
          return { ok: false, error: 'record_scope_denied', served_by: 'demo-mcp:get_entitled_record' };
        }
        const r = await readEntitledRecord(c.env, {
          actor, owner, recordType,
          fields: Array.isArray(args?.fields) ? args!.fields : undefined,
          purpose: typeof args?.purpose === 'string' ? args.purpose : undefined,
          audience: c.env.MCP_AUDIENCE,
        });
        if (!r.ok) return { ...r, served_by: 'demo-mcp:get_entitled_record' };
        return { ok: true, owner, actor, recordType, data: r.data, allowedFields: r.allowedFields, served_by: 'demo-mcp:get_entitled_record' };
      },
      {
        toolName: 'get_entitled_record',
        classification: ENTITLED_READ_CLASSIFICATION,
        auditSink,
        correlationId: getCorrelationId(c),
        environment: (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'
          ? 'production'
          : 'development'),
      },
    );
    const result = await handler({ token: body.token, args: body.args ?? {}, invocationProof: body.invocationProof } as Parameters<typeof handler>[0] & { invocationProof?: AgenticInvocationProofV1 });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code, (e as any).reason, e.stack); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

// ─── get_impact_profile / set_impact_profile — service-MAC, owner-own (spec 278 + spec 288 §6) ──────────
// The Personal Trust Home (demo-sso-next) reads/writes the member's OWN community profile (the encrypted
// `vault:impact-profile` record). The home holds no client-side delegation for the member, so this is an
// OWNER-OWN op: the principal is asserted by demo-a2a (service-MAC-trusted — parity with the open OAuth mint)
// and rides in args. SAME record + SAME per-person vault-key gate as the OAuth `get_impact_profile` dispatch,
// but served on the service-MAC `/tools/*` path (NOT the gateway-gated `/mcp` ingress) so it works when the
// edge is REQUIRED (home → /a2a/mcp/profile/* → demo-a2a → here, all behind the edge). No binding ⇒ fail
// closed. This is the through-a2a replacement for the home's former browser→/mcp-bind/mcp direct call (ADR-0044).
//
// Classifications (N10 — every MCP tool is classified). These tools are owner-own + service-MAC-gated +
// vault-key-authorized (NOT withDelegation-evaluated), so the classification is audit/lint metadata; risk
// mirrors get_profile (read=low) / set_vault_record (write=medium).
const GET_IMPACT_PROFILE_CLASSIFICATION = { '@sa-tool': 'delegation-verified', '@sa-auth': 'session-token', '@sa-risk-tier': 'low' } as const;
declareTool({ name: 'get_impact_profile' }, GET_IMPACT_PROFILE_CLASSIFICATION);
const SET_IMPACT_PROFILE_CLASSIFICATION = { '@sa-tool': 'delegation-verified', '@sa-auth': 'session-token', '@sa-risk-tier': 'medium' } as const;
declareTool({ name: 'set_impact_profile' }, SET_IMPACT_PROFILE_CLASSIFICATION);

app.post('/tools/get_impact_profile', async (c) => {
  const principal = (c.get('parsedBody')?.args as { principal?: string } | undefined)?.principal as Address | undefined;
  if (!principal) return c.json({ ok: false, error: 'principal required' }, 400);
  const resource = `${VAULT_RECORD_PREFIX}impact-profile`;
  const gate = await authorizePersonVaultOp(c.env, principal, resource, 'read', 'pii.low');
  if (!gate.ok) return c.json({ ok: false, error: gate.error, served_by: 'demo-mcp:get_impact_profile' });
  const obj = await gate.pv.vault.read({ owner: principal, resource });
  return c.json({ ok: true, principal, record: obj?.data ?? null, served_by: 'demo-mcp:get_impact_profile' });
});

app.post('/tools/set_impact_profile', async (c) => {
  const args = c.get('parsedBody')?.args as { principal?: string; data?: unknown } | undefined;
  const principal = args?.principal as Address | undefined;
  if (!principal) return c.json({ ok: false, error: 'principal required' }, 400);
  const resource = `${VAULT_RECORD_PREFIX}impact-profile`;
  const gate = await authorizePersonVaultOp(c.env, principal, resource, 'write', 'internal');
  if (!gate.ok) return c.json({ ok: false, error: gate.error, served_by: 'demo-mcp:set_impact_profile' });
  await gate.pv.vault.write({ owner: principal, resource, data: args?.data ?? null });
  return c.json({ ok: true, principal, served_by: 'demo-mcp:set_impact_profile' });
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

// CORS for the OAuth ingress — public HTTP MCP clients (incl. browsers, e.g.
// demo-web-pro) call these routes cross-origin. Auth is by Bearer header, NOT
// cookies, so we echo the request Origin and DON'T allow credentials (no
// ambient-authority surface). Applies ONLY to the OAuth routes; the service-MAC
// /tools/* worker-to-worker path is unaffected. Short-circuits the OPTIONS
// preflight; otherwise tags the handler's response with the CORS headers.
const OAUTH_CORS_PATHS = [
  '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/oauth/token', '/mcp',
  // spec 278 P5 — the connected-custodian vault-key ceremony is driven from the browser
  // (demo-web-pro), so its endpoints need the same cross-origin treatment as the OAuth ingress.
  // These carry no ambient authority: provision is fail-closed behind DEMO_VAULT_PROVISION_ENABLED,
  // and bind is gated by the person-SA signature it carries (verified server-side via ERC-1271).
  '/custody/vault-key/is-bound', '/custody/vault-key/server-info', '/custody/vault-key/provision', '/custody/vault-key/bind',
  // NOTE: /mcp/native gets the same treatment but is registered directly ABOVE its route — Hono
  // dispatches in registration order, and the route is declared earlier in this file than this block.
];
function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}
for (const path of OAUTH_CORS_PATHS) {
  app.use(path, async (c, next) => {
    const origin = c.req.header('Origin') ?? '*';
    if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    await next();
    const merged = new Headers(c.res.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) merged.set(k, v);
    c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers: merged });
  });
}

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

// ─── Connected-custodian vault-key binding (spec 278 P5) ──────────────────
//
// The HOST side of the ceremony. A person completes the connected-custodian flow
// (their SA signs a VAULT_KEY_USE authorization naming this server + their KEK) and
// POSTs the signed authorization here. We VERIFY it (the owner SA actually signed it
// — ERC-1271 via the UniversalSignatureValidator — and its caveat matches the KEK +
// scope) and persist the VaultKeyBinding. The signed authorization IS the owner's
// consent, so verifying it gates the write — no separate auth. Until a binding exists,
// every vault op for that owner is fail-closed (VKB-D1). The per-person KEK itself is
// provisioned out-of-band via spec 276 `ap-provision-gcp` (see docs/vault-key/ceremony.md).
app.post('/custody/vault-key/bind', async (c) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'malformed body' }, 400);
  }
  const owner = typeof body.owner === 'string' ? body.owner : undefined;
  const vaultId = typeof body.vaultId === 'string' ? body.vaultId : undefined;
  const kmsKeyRef = typeof body.kmsKeyRef === 'string' ? body.kmsKeyRef : undefined;
  const allowedResources = Array.isArray(body.allowedResources)
    ? body.allowedResources.filter((r): r is string => typeof r === 'string')
    : [];
  const classificationCeiling = typeof body.classificationCeiling === 'string' ? body.classificationCeiling : undefined;
  const ops = Array.isArray(body.ops)
    ? body.ops.filter((o): o is 'read' | 'write' => o === 'read' || o === 'write')
    : [];
  const expiresAt = typeof body.expiresAt === 'string' ? body.expiresAt : undefined;
  const authorization = body.authorization;
  if (!owner || !vaultId || !kmsKeyRef || !classificationCeiling || !expiresAt || allowedResources.length === 0 || ops.length === 0 || authorization == null) {
    return c.json({ error: 'invalid_request', error_description: 'owner, vaultId, kmsKeyRef, allowedResources, classificationCeiling, ops, expiresAt, authorization required' }, 400);
  }
  // The authorization arrives in WIRE form (salt serialized as a string — bigint isn't JSON).
  // Coerce salt back to bigint so hashDelegation recomputes the EXACT digest the person SA signed.
  const rawSalt = (authorization as { salt?: unknown }).salt;
  if (typeof rawSalt !== 'string' && typeof rawSalt !== 'number' && typeof rawSalt !== 'bigint') {
    return c.json({ error: 'invalid_request', error_description: 'authorization.salt required' }, 400);
  }
  let normalizedAuthorization: Delegation;
  try {
    normalizedAuthorization = { ...(authorization as object), salt: BigInt(rawSalt) } as Delegation;
  } catch {
    return c.json({ error: 'invalid_request', error_description: 'authorization.salt malformed' }, 400);
  }
  try {
    const res = await verifyAndStoreBinding(c.env, {
      owner, vaultId, kmsKeyRef, allowedResources, classificationCeiling, ops, expiresAt,
      authorization: normalizedAuthorization,
    });
    if (!res.ok) return c.json({ ok: false, error: 'authorization_invalid', reason: res.reason }, 401);
    return c.json({ ok: true, owner, kmsKeyRef, server_id: VAULT_SERVER_ID });
  } catch (e) {
    return c.json({ ok: false, error: 'bind_failed', detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// spec 278 — one-click ceremony support. The two values a person used to hand-enter are both
// system-supplied: the KEK is operator-provisioned (so we provision-on-demand + return the ref) and
// the delegate is THIS server's (so we advertise it). With both auto-filled the ceremony is just a
// signature. (serverKey isn't yet pinned by the read verifier — hardening follow-up.)
// GET /custody/vault-key/is-bound?owner=0x… — does this owner already have a live binding? Lets
// onboarding skip the activation step (and any signature) for already-activated returning members.
app.get('/custody/vault-key/is-bound', async (c) => {
  const owner = c.req.query('owner');
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
    return c.json({ ok: false, error: 'invalid_request', error_description: 'owner (0x address) query param required' }, 400);
  }
  // Per-owner + state-changing-over-time (a ceremony flips it) ⇒ never cache (a stale 404/false at
  // the edge would make onboarding re-prompt or wrongly skip).
  c.header('Cache-Control', 'no-store');
  // Spec 311 (server complement) — CURRENCY check, not existence: a binding whose stored authorization
  // was signed against a previous DelegationManager (a full-reset redeploy) exists but no longer verifies,
  // so returning bound:true would let the client skip re-binding and every read would 401. This re-runs
  // the read-path signature verify; a stale binding surfaces as bound:false (+stale:true) → onboarding
  // re-binds against the live contracts. `stale` is advisory for observability; existing clients that gate
  // on `bound` re-bind automatically.
  const { bound, stale, allowedResources } = await isVaultKeyBindingCurrent(c.env, owner);
  return c.json({ ok: true, owner, bound, stale, allowedResources });
});

app.get('/custody/vault-key/server-info', (c) => {
  // spec 253 batching — the DETERMINISTIC per-owner KEK ref, COMPUTED (never minted here) from the same
  // inputs `provision` uses: projects/<project>/locations/<loc>/keyRings/<ring>/cryptoKeys/<sanitizeKeyId(owner)>.
  // A device-via onboarding fetches it with ?owner=<sa> to pre-build the vault-key authorization and
  // pre-approve its digest INSIDE the deploy userOp (no separate bind signature). Same value the provision
  // call later returns; null when the GCP env is unset ⇒ the client falls back to signing the bind.
  const owner = (c.req.query('owner') ?? '').trim().toLowerCase();
  let kmsKeyRef: string | null = null;
  if (/^0x[0-9a-fA-F]{40}$/.test(owner)) {
    try {
      const raw = (c.env.GCP_SERVICE_ACCOUNT_JSON ?? '').trim();
      const sa = JSON.parse(raw.startsWith('{') ? raw : atob(raw)) as { project_id?: string };
      const location = (c.env.GCP_KEK_LOCATION ?? '').trim() || 'us-east1';
      const keyRing = (c.env.GCP_KEK_KEYRING ?? '').trim() || 'vault-keks';
      if (sa.project_id) kmsKeyRef = `projects/${sa.project_id}/locations/${location}/keyRings/${keyRing}/cryptoKeys/${sanitizeKeyId(owner)}`;
    } catch { /* GCP env absent/unparseable → null; client signs the bind the old way */ }
    // Dev-only local KEK (no GCP): same deterministic-ref contract, derived per owner.
    if (!kmsKeyRef && localKekEnabled(c.env)) kmsKeyRef = localKekRef(owner);
  }
  return c.json({
    serverId: VAULT_SERVER_ID,
    vaultId: VAULT_SERVER_ID,
    serverKey: (c.env.VAULT_KEY_SERVER_DELEGATE ?? '').trim() || '0x0000000000000000000000000000000000000001',
    kmsKeyRef,
    // `vault:*` authorizes the person's WHOLE own vault-record namespace (impact-profile, jp:adopter,
    // jp:facilitator, gs:offering, …) — relying apps store member-owned records under `vault:<app>:<type>`,
    // and the narrow per-record default broke them (resource_not_authorized → vault_key_unauthorized). The
    // SENSITIVE families (person-pii/org-sensitive/profile) stay listed explicitly; per-field/cross-principal
    // narrowing is the separate entitlement + DATA_SCOPE layer, not this owner-self binding scope.
    defaultResources: [RESOURCE_PERSON_PII, RESOURCE_ORG_SENSITIVE, RESOURCE_PROFILE, `${VAULT_RECORD_PREFIX}*`],
    classificationCeiling: 'regulated.high',
    ops: ['read', 'write'],
  });
});

// POST /custody/vault-key/provision { owner } — provision (idempotent) the owner's per-person
// symmetric KEK in GCP Cloud KMS and return its resource name (the kmsKeyRef the ceremony binds).
// Per-SA key id ⇒ re-calling is a no-op (409 → skip). project_id + runtime SA come from the same
// GCP_SERVICE_ACCOUNT_JSON demo-mcp wields KEKs with (it holds roles/cloudkms.admin); location +
// key ring are config (GCP_KEK_LOCATION / GCP_KEK_KEYRING).
//
// FAIL-CLOSED behind DEMO_VAULT_PROVISION_ENABLED (mirrors DEMO_OAUTH_MINT_ENABLED): this endpoint
// wields an ADMIN credential and creates a real (cost-bearing) GCP key per distinct owner — an open
// mint is a testnet-only convenience. The demo sets the flag so the one-click ceremony can
// auto-provision; a real deployment leaves it UNSET (route 404s) and provisions out of band
// (operator-side `provision-vault-kek.ts`, ideally with a least-privilege/separate admin credential).
app.post('/custody/vault-key/provision', async (c) => {
  if (c.env.DEMO_VAULT_PROVISION_ENABLED !== 'true') return c.json({ error: 'not_found' }, 404);
  // Dev-only local KEKs (vault-key.ts): nothing to mint — the ref is derived — but the owner-control
  // proof below is still enforced so the route contract is identical.
  const useLocalKek = !c.env.GCP_SERVICE_ACCOUNT_JSON && localKekEnabled(c.env);
  if (!c.env.GCP_SERVICE_ACCOUNT_JSON && !useLocalKek) {
    return c.json({ error: 'unsupported', error_description: 'GCP_SERVICE_ACCOUNT_JSON unset (provisioning unavailable)' }, 501);
  }
  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { body = {}; }
  const owner = typeof body.owner === 'string' ? body.owner : undefined;
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
    return c.json({ error: 'invalid_request', error_description: 'owner (0x address) required' }, 400);
  }
  // mcp-provision-unauth-prod (2026-07-04 self-audit): this endpoint wields an ADMIN GCP-KMS credential
  // and creates a real, cost-bearing KEK per distinct owner. It must NOT provision for an arbitrary
  // body-supplied address — require the caller to prove control of `owner` (ERC-1271 over a
  // freshness-bound challenge), same gate as /oauth/token. FAIL-CLOSED by default (ADR-0045): a real
  // deployment leaves DEMO_VAULT_PROVISION_SKIP_PROOF unset ⇒ proof enforced (missing/stale/invalid → 401).
  // The named, greppable, testnet-only opt-out lets the live demo ceremony auto-provision while its 4
  // client callers (demo-sso-next / demo-a2a / demo-web-pro) are updated to sign the provision challenge.
  // Phase C / NEW-C3: SKIP_PROOF is a TESTNET-ONLY opt-out — in production it is REFUSED (the owner-control
  // proof is always enforced), so a prod config that sets it to 'true' can no longer re-open the hole
  // (mirrors the local-aes production guard). Only honored outside production.
  const isProduction = typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';
  const skipProof = c.env.DEMO_VAULT_PROVISION_SKIP_PROOF === 'true' && !isProduction;
  if (!skipProof) {
    const issuedAt = typeof body.issuedAt === 'number' ? body.issuedAt : Number(body.issuedAt);
    const proofSig = typeof body.proof === 'string' ? body.proof : undefined;
    const proof = await verifyProvisionControlProof(
      { RPC_URL: c.env.RPC_URL, UNIVERSAL_SIGNATURE_VALIDATOR: c.env.UNIVERSAL_SIGNATURE_VALIDATOR },
      owner,
      issuedAt,
      proofSig,
      Math.floor(Date.now() / 1000),
    );
    if (!proof.ok) return c.json({ error: 'unauthorized', error_description: proof.reason }, 401);
  }
  if (useLocalKek) {
    return c.json({ ok: true, owner: owner.toLowerCase(), kmsKeyRef: localKekRef(owner), alreadyExisted: true });
  }
  let sa: { project_id?: string; client_email?: string };
  try {
    const raw = c.env.GCP_SERVICE_ACCOUNT_JSON!.trim();
    sa = JSON.parse(raw.startsWith('{') ? raw : atob(raw)) as { project_id?: string; client_email?: string };
  } catch {
    return c.json({ error: 'misconfigured', error_description: 'GCP_SERVICE_ACCOUNT_JSON not parseable' }, 500);
  }
  if (!sa.project_id || !sa.client_email) {
    return c.json({ error: 'misconfigured', error_description: 'service account JSON missing project_id/client_email' }, 500);
  }
  const location = (c.env.GCP_KEK_LOCATION ?? '').trim() || 'us-east1';
  const keyRing = (c.env.GCP_KEK_KEYRING ?? '').trim() || 'vault-keks';
  try {
    const result = await executeGcpProvision(
      { project: sa.project_id, location, keyRing, identities: [owner], runtimeServiceAccount: sa.client_email, purpose: 'encrypt-decrypt' },
      createGcpRestStepExecutor({ serviceAccountJson: c.env.GCP_SERVICE_ACCOUNT_JSON! }),
    );
    const kmsKeyRef = result.keyMap[owner];
    if (!kmsKeyRef) return c.json({ ok: false, error: 'provision_failed', error_description: 'no key in provisioning result' }, 500);
    return c.json({ ok: true, owner, kmsKeyRef, alreadyExisted: result.alreadyExisted });
  } catch (e) {
    return c.json({ ok: false, error: 'provision_failed', detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});

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
  const fields = Array.isArray(body.fields) ? (body.fields.filter((f): f is string => typeof f === 'string')) : undefined;
  const ttlSeconds = typeof body.ttl_seconds === 'number' ? body.ttl_seconds : undefined;

  // KC-1b (seam audit): the open mint used to issue a bearer for ANY requested principal with no proof
  // the caller controls it → one-request cross-principal PII read on a public deployment. Require the
  // caller to PROVE control of the principal: an ERC-1271 signature (via the USV) over a freshness-bound
  // challenge binding every mint parameter. Fail-closed — no/invalid/stale proof ⇒ no mint.
  const proofInput = { principal, audience: c.env.MCP_AUDIENCE, issuedAt: typeof body.issued_at === 'number' ? body.issued_at : NaN, scopes, fields, ttlSeconds };
  const proof = await verifyPrincipalControlProof(
    c.env,
    proofInput,
    typeof body.principal_proof === 'string' ? body.principal_proof : undefined,
    Math.floor(Date.now() / 1000),
  );
  if (!proof.ok) {
    return c.json({ error: 'unauthorized', error_description: `principal control proof failed: ${proof.reason}` }, 401);
  }

  try {
    const result = await mintDemoMcpToken(c.env, {
      principal,
      audience: c.env.MCP_AUDIENCE,
      issuer: new URL(c.req.url).origin,
      clientId: typeof body.client_id === 'string' ? body.client_id : undefined,
      scopes,
      fields,
      purpose: typeof body.purpose === 'string' ? body.purpose : undefined,
      ttlSeconds,
    });
    return c.json(result);
  } catch (e) {
    // spec 278: minting stores the grant bundle under the principal's per-person KEK,
    // which requires a vault-key binding. No binding ⇒ fail closed (409), not a 500.
    return c.json({ error: 'vault_key_unauthorized', error_description: e instanceof Error ? e.message : String(e) }, 409);
  }
});

// Public bearer-gated MCP tool call. Validates the token's claims (signature
// injected via HS256), resolves the grant bundle from the vault (anti-swap hash
// check inside), then runs the SAME authority chain as the service-MAC routes.
app.post('/mcp', async (c) => {
  const metaUrl = new URL('/.well-known/oauth-protected-resource', c.req.url).toString();
  if (!c.env.OAUTH_SIGNING_SECRET) return c.json({ error: 'unsupported', error_description: 'OAuth ingress not configured' }, 501);

  // Read the RAW body once (for the GatewayAssertion digest); the bearer logic below parses from it.
  const rawText = await c.req.text().catch(() => '');
  // GatewayAssertion (spec 288 §6) — gate BEFORE the OAuth logic so a direct caller gets a single generic
  // gateway_assertion_required (no OAuth-surface leak). Advisory unless DEMO_REQUIRE_GATEWAY_ASSERTION.
  const gaOauth = await checkGatewayAssertion(c, rawText, { path: '/mcp', operationId: 'mcp.oauth' });
  if (gaOauth) return gaOauth;

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
  try { body = JSON.parse(rawText) as Record<string, unknown>; } catch { body = {}; }
  const tool = typeof body.tool === 'string' ? body.tool : (typeof body.method === 'string' ? body.method : '');

  // spec 278 — the home's community contact profile (`ImpactContactProfile`) is a per-person
  // ENCRYPTED vault record (`vault:impact-profile`), distinct from the seeded person-pii. The
  // Personal Trust Home reads (`/you`) + writes (`/profile`) it over this OAuth ingress on the
  // owner's own behalf (ap_principal). Both ops are binding-gated (read / write op on the person's
  // vault-key authorization); no binding ⇒ fail closed. Sealed/opened under the person's GCP KEK.
  if (tool === 'get_impact_profile' || tool === 'set_impact_profile') {
    const resource = `${VAULT_RECORD_PREFIX}impact-profile`;
    if (tool === 'set_impact_profile') {
      const data = (body.args as { data?: unknown } | undefined)?.data ?? null;
      const gate = await authorizePersonVaultOp(c.env, principal, resource, 'write', 'internal');
      if (!gate.ok) return c.json({ ok: false, error: gate.error, served_by: 'demo-mcp:set_impact_profile' });
      await gate.pv.vault.write({ owner: principal, resource, data });
      return c.json({ ok: true, tool, principal, served_by: 'demo-mcp:set_impact_profile' });
    }
    const gate = await authorizePersonVaultOp(c.env, principal, resource, 'read', 'pii.low');
    if (!gate.ok) return c.json({ ok: false, error: gate.error, served_by: 'demo-mcp:get_impact_profile' });
    const obj = await gate.pv.vault.read({ owner: principal, resource });
    return c.json({ ok: true, tool, principal, record: obj?.data ?? null, served_by: 'demo-mcp:get_impact_profile' });
  }

  const spec = OAUTH_TOOL_SPECS[tool];
  if (!spec) return c.json({ ok: false, error: 'unknown_tool', tool, supported: [...Object.keys(OAUTH_TOOL_SPECS), 'get_impact_profile', 'set_impact_profile'] }, 400);
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

// update_profile — delegation-verified WRITE to the person's encrypted vault profile.
// Mirrors get_profile (read) + set_vault_record (write gate): the principal recovered by
// withDelegation IS the delegator, and spec 278 requires op:'write' on that person's vault-key
// authorization. Partial patch over the current (seal-on-read) profile; server stamps
// owner_address + updated_at. No binding ⇒ fail closed (vault_key_unauthorized).
app.post('/tools/update_profile', async (c) => {
  const body = c.get('parsedBody');
  if (!body?.token) return c.json({ error: 'token required' }, 400);
  const auditSink = buildAuditSink(c.env);
  type Args = { args?: { full_name?: string; email?: string; phone?: string | null; notes?: string | null } };
  const handler = withDelegation<Args>(
    withProof(c.env, baseConfig(c.env), body.invocationProof),
    async ({ principal, args }) => {
      const gate = await authorizePersonVaultOp(c.env, principal, RESOURCE_PROFILE, 'write', 'pii.low');
      if (!gate.ok) return { ok: false, error: gate.error, served_by: 'demo-mcp:update_profile' };
      const current = (await gate.pv.vault.read<Profile>({ owner: principal, resource: RESOURCE_PROFILE }))?.data ?? buildSeedProfile(principal);
      const next: Profile = {
        ...current,
        owner_address: principal.toLowerCase(),
        ...(typeof args?.full_name === 'string' ? { full_name: args.full_name } : {}),
        ...(typeof args?.email === 'string' ? { email: args.email } : {}),
        ...(args?.phone !== undefined ? { phone: args.phone } : {}),
        ...(args?.notes !== undefined ? { notes: args.notes } : {}),
        updated_at: new Date().toISOString(),
      };
      await gate.pv.vault.write<Profile>({ owner: principal, resource: RESOURCE_PROFILE, data: next });
      const owner_name = await resolveAgentName(c.env, principal);
      return { ok: true, profile: next, owner_name, served_by: 'demo-mcp:update_profile' };
    },
    {
      toolName: 'update_profile',
      classification: UPDATE_PROFILE_CLASSIFICATION,
      auditSink,
      correlationId: getCorrelationId(c),
      environment: (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production' ? 'production' : 'development'),
    },
  );
  try {
    const result = await handler({ token: body.token, args: body.args ?? {}, invocationProof: body.invocationProof } as Parameters<typeof handler>[0] & { invocationProof?: AgenticInvocationProofV1 });
    return c.json(result as Record<string, unknown>);
  } catch (e) {
    if (e instanceof McpAuthError) { console.error('[demo-mcp] McpAuthError:', e.message, e.code, (e as any).reason, e.stack); return c.json({ error: 'auth failed', detail: e.message, code: e.code }, 401); }
    return c.json({ error: 'internal error', detail: String(e) }, 500);
  }
});

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
    // spec 278: seeding materializes the profile under the person's KEK — requires a binding.
    const pv = await resolvePersonVault(c.env, address);
    if (!pv) return c.json({ ok: false, error: 'vault_key_unauthorized', detail: 'no vault-key binding for this address; run the connected-custodian ceremony first (spec 278 P5)' }, 409);
    const obj = await pv.vault.read<Profile>({ owner: address, resource: RESOURCE_PROFILE });
    return c.json({ ok: true, profile: obj?.data ?? null });
  });
}

export default app;
