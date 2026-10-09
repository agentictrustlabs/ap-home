// A SELF-HOSTED AGENT'S READS GO TO ITS OWN HOST — spec 433 W2. The Home sends every `/harness/*` read here (its `/a2a/*`
// rewrite), but a service that embeds the Service Host keeps its runs on ITS object, at the origin its name records
// publish. So before answering a read from THIS Worker's object, ask the records: when the addressee's `a2aEndpoint` is not
// an origin this Worker serves, the read is forwarded there under the agent's own read wire, and its answer returned verbatim.
// Records-first and nothing else (ADR-0013): a self-hosted agent whose host cannot be reached is said to be unreachable —
// never answered from the empty object here as if it had done nothing.
import type { Address, Hex } from 'viem';
import type { DelegationWireV1 } from '@agenticprimitives/a2a';
import { signedSelfHostRead } from './self-host-wire.js';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { a2aBaseDomains, AGENT_NAME_PARENT } from './host-context.js';
import { nameRecordsReader, subjectAddress, servesUnpublishedNames } from './subject-address.js';

export interface SelfHostedReadEnv {
  RPC_URL?: string; CHAIN_ID?: string; AGENT_NAME_REGISTRY?: string; AGENT_NAME_UNIVERSAL_RESOLVER?: string; PROFILE_RESOLVER?: string;
  A2A_PUBLIC_BASE_DOMAIN?: string; AGENT_NAME_PARENTS?: string; AGENT_NAME_PARENT?: string;
  /** The ingress this deployment advertises on every card it serves — a record naming it is served HERE. */
  DEMO_EDGE_URL?: string; A2A_SERVES_UNPUBLISHED_NAMES?: string;
}

const recent = new Map<string, { at: number; origin: string | null }>();
const TTL_MS = 60_000;

/** The origin the addressee's records publish for its A2A surface, when it is NOT one this Worker serves; else null.
 *
 *  ONE RULE, the runtime's own (`subjectAddress`, subject-address.ts): `here` when the records name this deployment's
 *  ingress (`DEMO_EDGE_URL` — the edge every card here advertises), the host this deployment serves the name at, or no
 *  endpoint at all (the estate's unpublished names); `wire` when they name another host; `nowhere` when the registry does
 *  not know the name. The first version of this forward re-derived a weaker copy that did not know the edge, and every
 *  person whose records point at `edge.faithnet.io` lost their reads (2026-10-09: "this Home holds no read wire for it"). */
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
      const parents = (env.AGENT_NAME_PARENTS ?? env.AGENT_NAME_PARENT ?? AGENT_NAME_PARENT).split(',').map((p: string) => p.trim()).filter(Boolean);
      const where = subjectAddress(name, r, { ownIngress: env.DEMO_EDGE_URL?.trim() || selfOrigin, ownDomains: a2aBaseDomains(env), parents, servesUnpublished: servesUnpublishedNames(env) });
      if (where.where === 'wire') {
        const host = new URL(where.cardUrl).origin;
        origin = host === selfOrigin ? null : host;
      }
    } catch { origin = null; }
  }
  recent.set(key, { at: Date.now(), origin });
  return origin;
}

export interface SelfHostForwardAuth {
  /** The verified caller of the read (the Home session's person, or an app delegation's). */
  caller: Address;
  /** The runtime's rule: the agent itself, or a steward whose wire verifies on chain (`mayOverseeAgent`). */
  mayOversee: (caller: Address, agent: Address) => Promise<boolean>;
  /** The agent's read wire kept on its object here (`getSelfHostWire`); null ⇒ the ceremony has not been run. */
  wire: (agent: Address) => Promise<DelegationWireV1 | null>;
  /** This runtime's interactions-session key, signing the per-read assertion. */
  signDigest: (digest: Hex) => Promise<Hex>;
}

/** Forward a `/harness/*` read to the addressee's own host; `null` when the addressee is served here.
 *
 *  UNDER THE AGENT'S OWN WIRE, never the caller's session: a self-hosted agent cannot verify this estate's session token, so
 *  the read is presented as an `A2A-Session` assertion by this runtime's key over the agent's read wire (spec 433 W2) — the
 *  credential the agent's custodian issued to this Home at charter. Which is why the caller must first be someone the
 *  runtime would let read here: the agent itself or a steward; a signed-in stranger does not get to ride the Home's wire.
 *  No wire ⇒ said, with the ceremony to run; never a fallback to the session (ADR-0013). */
export async function forwardToSelfHost(env: SelfHostedReadEnv, request: Request, addressee: Address, raw: string, auth: SelfHostForwardAuth): Promise<Response | null> {
  const url = new URL(request.url);
  const origin = await selfHostOriginOf(env, addressee, url.origin);
  if (!origin) return null;
  if (!(await auth.mayOversee(auth.caller, addressee).catch(() => false))) {
    return Response.json({ ok: false, error: `${addressee} is served at ${origin}; only the agent itself or a steward reads its runs through this Home` }, { status: 403, headers: { 'x-ap-self-hosted': origin } });
  }
  const wire = await auth.wire(addressee).catch(() => null);
  if (!wire) {
    return Response.json({ ok: false, error: `${addressee} is served at ${origin} and this Home holds no read wire for it — its steward issues one (scripts/issue-self-host-read-wire.mts <name> --by <steward>)` }, { status: 401, headers: { 'x-ap-self-hosted': origin } });
  }
  let body: Record<string, unknown> = {};
  try { body = (JSON.parse(raw) as Record<string, unknown>) ?? {}; } catch { body = {}; }
  try {
    const signed = await signedSelfHostRead(wire, body, origin, auth.signDigest);
    const res = await fetch(`${origin}${url.pathname}`, { method: 'POST', headers: signed.headers, body: signed.raw });
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'x-ap-self-hosted': origin } });
  } catch (e) {
    return Response.json({ ok: false, error: `${addressee} is served at ${origin}, which could not be reached: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}
