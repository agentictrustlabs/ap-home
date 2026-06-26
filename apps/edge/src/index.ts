// Agentic Edge admission Worker (spec 288 §6).
//
// The only public ingress: it runs the vendor-neutral admission pipeline (edge-runtime) via the
// Cloudflare adapter (edge-cloudflare), serves the native discovery doc, and dispatches admitted
// bytes to the private demo-mcp / demo-a2a origins over Service Bindings. It owns NO authority
// (ADR-0043) — the downstream Workers still run the full Web3 pipeline (delegation + signature +
// entitlement + policy). The edge admits + shuttles; it never decides authorization.

import { runAdmission, type AdmissionRequest } from '@agenticprimitives/edge-runtime';
import {
  extractAdmissionRequest,
  createCloudflareRateLimiter,
  dispatchToBinding,
  type RateLimiterBinding,
  type FetcherLike,
} from '@agenticprimitives/edge-cloudflare';
import { buildAgenticAuthorizationProfile, serveAgenticAuthorization } from '@agenticprimitives/agentic-authorization';
import type {
  CapabilityDescriptor,
  CapabilityProtocol,
  CapabilityRiskTier,
} from '@agenticprimitives/capability-registry';

interface Env {
  /** Service Bindings to the private origins (no public hop). */
  MCP: FetcherLike;
  A2A: FetcherLike;
  /** Workers rate-limiter binding — Stage-1 abuse only. */
  EDGE_LIMITER: RateLimiterBinding;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Native discovery — served at the edge from public on-chain config only (spec 292).
    if (request.method === 'GET' && url.pathname === '/.well-known/agentic-authorization') {
      const profile = buildAgenticAuthorizationProfile({
        chainId: Number(env.CHAIN_ID),
        entryPoint: env.ENTRY_POINT as `0x${string}`,
        delegationManager: env.DELEGATION_MANAGER as `0x${string}`,
        universalSignatureValidator: env.UNIVERSAL_SIGNATURE_VALIDATOR as `0x${string}`,
      });
      return serveAgenticAuthorization(profile);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'demo-edge' }, 200);
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
        'x-correlation-id': result.correlationId,
      });
    }
    if (!route) return json({ error: 'admission denied', correlationId: result.correlationId }, 500);

    const fetcher = route.binding === 'MCP' ? env.MCP : env.A2A;
    return dispatchToBinding(fetcher, {
      url: request.url,
      method: admission.method,
      headers: result.headers,
      correlationId: result.correlationId,
      rawBody,
    });
  },
};
