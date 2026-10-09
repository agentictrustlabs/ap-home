// A SELF-HOSTED AGENT'S READS GO TO ITS OWN HOST — spec 433 W2. The Home sends every `/harness/*` read here (its `/a2a/*`
// rewrite), but a service that embeds the Service Host keeps its runs on ITS object, at the origin its name records
// publish. So before answering a read from THIS Worker's object, ask the records: when the addressee's `a2aEndpoint` is not
// an origin this Worker serves, the read is forwarded there, same body, same bearer, and its answer returned verbatim.
// Records-first and nothing else (ADR-0013): a self-hosted agent whose host cannot be reached is said to be unreachable —
// never answered from the empty object here as if it had done nothing.
import type { Address } from 'viem';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { a2aBaseDomains, a2aCanonicalDomain, hostForName, AGENT_NAME_PARENT } from './host-context.js';
import { nameRecordsReader } from './subject-address.js';

export interface SelfHostedReadEnv {
  RPC_URL?: string; CHAIN_ID?: string; AGENT_NAME_REGISTRY?: string; AGENT_NAME_UNIVERSAL_RESOLVER?: string; PROFILE_RESOLVER?: string;
  A2A_PUBLIC_BASE_DOMAIN?: string; AGENT_NAME_PARENTS?: string; AGENT_NAME_PARENT?: string;
}

const recent = new Map<string, { at: number; origin: string | null }>();
const TTL_MS = 60_000;

/** The origin the addressee's records publish for its A2A surface, when it is NOT one this Worker serves; else null. */
export async function selfHostOriginOf(env: SelfHostedReadEnv, addressee: Address, selfOrigin: string): Promise<string | null> {
  const key = addressee.toLowerCase();
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.origin;
  const records = nameRecordsReader(env as never);
  let origin: string | null = null;
  if (records && env.RPC_URL && env.AGENT_NAME_REGISTRY && env.AGENT_NAME_UNIVERSAL_RESOLVER) {
    try {
      const naming = new AgentNamingClient({ rpcUrl: env.RPC_URL, chainId: Number(env.CHAIN_ID), registry: env.AGENT_NAME_REGISTRY as Address, universalResolver: env.AGENT_NAME_UNIVERSAL_RESOLVER as Address, ...(env.PROFILE_RESOLVER ? { profileResolver: env.PROFILE_RESOLVER as Address } : {}) });
      const name = await naming.reverseResolve(addressee);
      const r = name ? await records(name) : null;
      const endpoint = r?.a2aEndpoint ? new URL(r.a2aEndpoint).origin : null;
      if (endpoint && name) {
        const zones = a2aBaseDomains(env);
        const parents = (env.AGENT_NAME_PARENTS ?? env.AGENT_NAME_PARENT ?? AGENT_NAME_PARENT).split(',').map((p: string) => p.trim()).filter(Boolean);
        const servedHost = hostForName(name, a2aCanonicalDomain(env), parents);
        const host = new URL(endpoint).hostname.toLowerCase();
        const servedHere = endpoint === selfOrigin || (servedHost && host === servedHost.toLowerCase()) || zones.some((z) => host === `a2a.${z}`);
        origin = servedHere ? null : endpoint;
      }
    } catch { origin = null; }
  }
  recent.set(key, { at: Date.now(), origin });
  return origin;
}

/** Forward a `/harness/*` read to the addressee's own host; `null` when the addressee is served here. */
export async function forwardToSelfHost(env: SelfHostedReadEnv, request: Request, addressee: Address, raw: string): Promise<Response | null> {
  const url = new URL(request.url);
  const origin = await selfHostOriginOf(env, addressee, url.origin);
  if (!origin) return null;
  const auth = request.headers.get('authorization');
  try {
    const res = await fetch(`${origin}${url.pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...(auth ? { authorization: auth } : {}) }, body: raw });
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'x-ap-self-hosted': origin } });
  } catch (e) {
    return Response.json({ ok: false, error: `${addressee} is served at ${origin}, which could not be reached: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}
