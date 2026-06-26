// Agentic Edge admission Worker (spec 288 §6).
//
// The only public ingress: it runs the vendor-neutral admission pipeline (edge-runtime) via the
// Cloudflare adapter (edge-cloudflare), serves the native discovery doc, and dispatches admitted
// bytes to the private demo-mcp / demo-a2a origins over Service Bindings. It owns NO authority
// (ADR-0043) — the downstream Workers still run the full Web3 pipeline (delegation + signature +
// entitlement + policy). The edge admits + shuttles; it never decides authorization.

import {
  runAdmission,
  issueGatewayAssertion,
  createHmacGatewayAssertionSigner,
  type AdmissionRequest,
} from '@agenticprimitives/edge-runtime';
import {
  extractAdmissionRequest,
  createCloudflareRateLimiter,
  dispatchToBinding,
  type RateLimiterBinding,
  type FetcherLike,
} from '@agenticprimitives/edge-cloudflare';
import { buildAgenticAuthorizationProfile, serveAgenticAuthorization } from '@agenticprimitives/agentic-authorization';
import { createDurableObjectBudgetStore, type BudgetDoNamespace } from '@agenticprimitives/rate-control-cloudflare';
import type {
  CapabilityDescriptor,
  CapabilityProtocol,
  CapabilityRiskTier,
} from '@agenticprimitives/capability-registry';

// The Stage-3 hard-budget Durable Object must be exported from the Worker entry so CF can bind it
// (spec 290 §8). One DO instance per Smart Agent shard.
export { SmartAgentBudgetDO } from '@agenticprimitives/rate-control-cloudflare';

interface Env {
  /** Service Bindings to the private origins (no public hop). */
  MCP: FetcherLike;
  A2A: FetcherLike;
  /** Workers rate-limiter binding — Stage-1 abuse only. */
  EDGE_LIMITER: RateLimiterBinding;
  /** Per-Smart-Agent hard-budget store (spec 290 §8) — Stage-3, post-authority. */
  SA_BUDGET: BudgetDoNamespace;
  SA_BUDGET_LIMIT_UNITS?: string;
  DEMO_BUDGET_PROBE_ENABLED?: string;
  /** Shared HMAC secret for the GatewayAssertion (spec 288 §4). When set, the edge signs an admission
   *  assertion the origin can verify. Same value on demo-mcp/demo-a2a. Unset ⇒ no assertion issued. */
  GATEWAY_ASSERTION_SECRET?: string;
  /** Comma-separated browser Origins allowed to call the edge (so browser callers can be repointed at it
   *  — route-lockdown prerequisite). Supports `https://*.suffix` wildcards. App config (ADR-0021). */
  EDGE_ALLOWED_ORIGINS?: string;
  /** Public on-chain config for the discovery doc. */
  CHAIN_ID: string;
  ENTRY_POINT: string;
  DELEGATION_MANAGER: string;
  UNIVERSAL_SIGNATURE_VALIDATOR: string;
}

type BindingName = 'MCP' | 'A2A';
interface Route {
  binding: BindingName;
  descriptor: CapabilityDescriptor;
}

function descriptor(
  id: string,
  protocol: CapabilityProtocol,
  riskTier: CapabilityRiskTier,
  maxBodyBytes: number,
): CapabilityDescriptor {
  return {
    id,
    protocol,
    inputSchema: { type: 'object' },
    authorization: { mode: 'agentic-delegation', riskTier },
    operations: {
      rateLimitProfile: 'edge-default',
      maxBodyBytes,
      timeoutMs: 15_000,
      idempotency: 'never-retry',
      cache: 'no-store',
    },
  };
}

// App-local route catalog (descriptor + which origin). Concrete paths/binding names are app config
// (ADR-0021), never in the generic packages. Native (spec 287) is the headline public delegation
// path; the others front the existing demo origins.
const CATALOG: { test: (method: string, path: string) => boolean; route: Route }[] = [
  { test: (m, p) => m === 'POST' && p === '/mcp/native', route: { binding: 'MCP', descriptor: descriptor('mcp.native', 'mcp', 'high', 256 * 1024) } },
  { test: (m, p) => m === 'POST' && p === '/mcp', route: { binding: 'MCP', descriptor: descriptor('mcp.oauth', 'mcp', 'high', 256 * 1024) } },
  { test: (m, p) => m === 'POST' && p === '/api/a2a', route: { binding: 'A2A', descriptor: descriptor('a2a.task', 'a2a', 'high', 256 * 1024) } },
  { test: (m, p) => m === 'GET' && p === '/.well-known/agent-card.json', route: { binding: 'A2A', descriptor: descriptor('a2a.card', 'a2a', 'low', 16 * 1024) } },
];

function matchRoute(req: AdmissionRequest): Route | undefined {
  for (const entry of CATALOG) if (entry.test(req.method, req.path)) return entry.route;
  return undefined;
}

function json(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

/** `sha256:<hex>` over the exact body bytes — the GatewayAssertion bodyDigest. The origin recomputes the
 *  same digest over the bytes it received (exact-byte forwarding makes them identical). */
async function bodyDigest(rawBody?: ArrayBuffer): Promise<string> {
  const buf = rawBody ?? new ArrayBuffer(0);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return 'sha256:' + [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The audience the edge stamps + the origin checks — both sides agree on this constant. */
const GATEWAY_ASSERTION_AUD = 'urn:agentic:edge';

/** Is `origin` in the allowlist (exact or `https://*.suffix` wildcard)? */
function isAllowedOrigin(origin: string | null, allowed?: string): boolean {
  if (!origin || !allowed) return false;
  for (const entry of allowed.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (entry === origin) return true;
    if (entry.startsWith('https://*.')) {
      const suffix = entry.slice('https://*.'.length);
      if (origin.startsWith('https://') && (origin.endsWith('.' + suffix) || origin === 'https://' + suffix)) return true;
    }
  }
  return false;
}

/** CORS headers for an allowed browser Origin (Bearer/JSON, no credentials — no ambient authority). */
function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS so browser callers (demo-web-pro etc.) can be repointed at the edge (route-lockdown
    // prerequisite). The edge answers the preflight + tags its OWN responses; for DISPATCHED requests
    // the origin sets ACAO off the forwarded Origin (not a stripped header), so we never double-tag.
    const origin = request.headers.get('Origin');
    const cors = isAllowedOrigin(origin, env.EDGE_ALLOWED_ORIGINS) ? corsHeaders(origin!) : {};
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // Native discovery — served at the edge from public on-chain config only (spec 292).
    if (request.method === 'GET' && url.pathname === '/.well-known/agentic-authorization') {
      const profile = buildAgenticAuthorizationProfile({
        chainId: Number(env.CHAIN_ID),
        entryPoint: env.ENTRY_POINT as `0x${string}`,
        delegationManager: env.DELEGATION_MANAGER as `0x${string}`,
        universalSignatureValidator: env.UNIVERSAL_SIGNATURE_VALIDATOR as `0x${string}`,
      });
      const res = serveAgenticAuthorization(profile);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'demo-edge' }, 200, cors);
    }

    // Stage-3 hard-budget DO smoke probe (demo-only, flag-gated). Exercises a full reserve →
    // over-limit deny → commit (charge actuals) → reserve-fits → release → reserve-fits cycle on
    // a fresh Smart Agent shard, against the real Durable Object. NOT a production route.
    if (request.method === 'POST' && url.pathname === '/budget/probe') {
      if (env.DEMO_BUDGET_PROBE_ENABLED !== 'true') return json({ error: 'not_found' }, 404, cors);
      const body = (await request.json().catch(() => ({}))) as { sponsorAgent?: string };
      const rnd = new Uint8Array(20);
      crypto.getRandomValues(rnd);
      const sponsorAgent = body.sponsorAgent ?? '0x' + [...rnd].map((b) => b.toString(16).padStart(2, '0')).join('');
      const limitUnits = Number(env.SA_BUDGET_LIMIT_UNITS ?? '10');
      const budget = createDurableObjectBudgetStore({ namespace: env.SA_BUDGET, chainId: Number(env.CHAIN_ID), limitUnits });
      const steps: { step: string; allowed?: boolean }[] = [];

      const r1 = await budget.reserve({ sponsorAgent, capabilityId: 'probe', estimatedUnits: 7, idempotencyKey: 'k1' });
      steps.push({ step: `reserve 7 (k1) [limit ${limitUnits}]`, allowed: r1.allowed });
      const r2 = await budget.reserve({ sponsorAgent, capabilityId: 'probe', estimatedUnits: 7, idempotencyKey: 'k2' });
      steps.push({ step: 'reserve 7 (k2) — expect DENY (over limit)', allowed: r2.allowed });
      if (r1.reservationId) await budget.commit(r1.reservationId, 3);
      steps.push({ step: 'commit k1 actual=3 (committed=3)' });
      const r3 = await budget.reserve({ sponsorAgent, capabilityId: 'probe', estimatedUnits: 6, idempotencyKey: 'k3' });
      steps.push({ step: 'reserve 6 (k3) — expect ALLOW (3+6<=10)', allowed: r3.allowed });
      if (r3.reservationId) await budget.release(r3.reservationId);
      steps.push({ step: 'release k3 (frees the 6)' });
      const r4 = await budget.reserve({ sponsorAgent, capabilityId: 'probe', estimatedUnits: 7, idempotencyKey: 'k4' });
      steps.push({ step: 'reserve 7 (k4) — expect ALLOW (3+7=10)', allowed: r4.allowed });

      const pass = r1.allowed && !r2.allowed && r3.allowed && r4.allowed;
      return json({ ok: pass, sponsorAgent, limitUnits, steps }, 200, cors);
    }

    // Admission: extract → runAdmission (header hygiene → size/depth/envelope → Stage-1 abuse) →
    // dispatch the exact bytes to the matched origin over its Service Binding.
    const { admission, rawBody } = await extractAdmissionRequest(request);
    const route = matchRoute(admission);

    const result = await runAdmission(admission, {
      resolveRoute: () => route?.descriptor,
      softLimiter: createCloudflareRateLimiter(env.EDGE_LIMITER),
    });

    if (!result.ok) {
      // Single generic error — never echo the internal classifier (info-leak; spec 288 §4).
      return json({ error: 'admission denied', correlationId: result.correlationId }, result.status, {
        ...cors,
        'x-correlation-id': result.correlationId,
      });
    }
    if (!route) return json({ error: 'admission denied', correlationId: result.correlationId }, 500, cors);

    // GatewayAssertion (spec 288 §4): the edge signs that it admitted THESE exact bytes for this route,
    // so the origin can prove the request came through admission (admission only — never authority). The
    // origin recomputes the bodyDigest over the forwarded bytes + verifies the HMAC. Skipped if no secret.
    const headers = { ...result.headers };
    if (env.GATEWAY_ASSERTION_SECRET) {
      const signed = await issueGatewayAssertion(
        {
          iss: 'demo-edge',
          aud: GATEWAY_ASSERTION_AUD,
          method: admission.method,
          path: admission.path,
          bodyDigest: await bodyDigest(rawBody),
          operationId: route.descriptor.id,
          correlationId: result.correlationId,
          ttlMs: 60_000,
        },
        createHmacGatewayAssertionSigner(env.GATEWAY_ASSERTION_SECRET),
      );
      headers['x-agentic-gateway-assertion'] = signed.token;
    }

    const fetcher = route.binding === 'MCP' ? env.MCP : env.A2A;
    return dispatchToBinding(fetcher, {
      url: request.url,
      method: admission.method,
      headers,
      correlationId: result.correlationId,
      rawBody,
    });
  },
};
