// The Home's A2A fetch transport — spec 341 Wave 4 (ADR-0059).
//
// `A2aWireAdapter` is transport-agnostic on purpose: the package never hardcodes HTTP, and the
// embedding app supplies how to reach an agent. This is that supply for the Home.
//
// TWO THINGS THIS HAS TO GET RIGHT, and both were found the hard way:
//
// 1. BIGINT SERIALIZATION. `Delegation.salt` is a `bigint` and `JSON.stringify` THROWS on it. Without
//    the replacer below every delivery dies before the network, with a `TypeError: Do not know how to
//    serialize a BigInt` that names neither A2A nor delegation. The receiving side parses salt back
//    from its decimal string — the `DelegationWire` convention — so a string here is the wire truth,
//    not a lossy convenience.
//
// 2. WHERE AN AGENT LIVES IS NOT THIS MODULE'S BUSINESS. `resolveAgentOrigin` is injected. The app
//    layer owns hostnames (ADR-0021), and injecting it also means the send path is testable without a
//    network or a naming registry.
//
// NOT AN AUTHORITY BOUNDARY. This moves bytes. Everything that decides whether the call is allowed
// happens at the recipient, against the grant and the signatures (ADR-0041) — a transport that
// "succeeded" says only that a peer answered.

import type { A2aTransport } from '@agenticprimitives/a2a';
import type { Address } from '@agenticprimitives/types';

/**
 * JSON with bigints as decimal strings.
 *
 * Deliberately NOT a general-purpose serializer: it exists because one field (`salt`) is a bigint and
 * the wire form for it is a decimal string. Anything else that needs custom encoding should say so at
 * its own type, not accumulate here.
 */
export function stringifyA2aRequest(request: unknown): string {
  return JSON.stringify(request, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
}

export interface A2aFetchTransportOpts {
  /** Agent SA → the origin serving its A2A endpoint. Injected: hostnames are app config (ADR-0021). */
  resolveAgentOrigin: (agent: Address) => Promise<string | null>;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Path the A2A JSON-RPC endpoint is served at, relative to the origin. */
  path?: string;
}

/**
 * Build the transport `A2aWireAdapter` needs.
 *
 * Fail-closed on an unresolvable agent: throwing beats posting to a guessed origin, which would send a
 * signed grant and a signed message to whoever happens to answer there. An unresolvable recipient is a
 * refusal, never a best effort (ADR-0013).
 */
export function makeA2aFetchTransport(opts: A2aFetchTransportOpts): A2aTransport {
  const doFetch = opts.fetchImpl ?? fetch;
  const path = opts.path ?? '/api/a2a';

  return {
    async rpc(targetAgent, request) {
      const origin = await opts.resolveAgentOrigin(targetAgent);
      if (!origin) {
        throw new Error(`cannot resolve an A2A endpoint for ${targetAgent} — refusing to guess`);
      }
      const res = await doFetch(`${origin.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stringifyA2aRequest(request),
      });
      // A non-2xx is a TRANSPORT failure and is not the same as a JSON-RPC error result. Collapsing
      // them would let "the host is down" read as "the agent refused you", and those call for
      // opposite responses.
      if (!res.ok) {
        throw new Error(`a2a transport ${res.status} from ${origin}`);
      }
      return (await res.json()) as Awaited<ReturnType<A2aTransport['rpc']>>;
    },
  };
}
