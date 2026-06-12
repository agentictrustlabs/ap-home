// GET /connect/name?base=<label> → the next free `<label>[N].impact` +
// its namehash node. Forced-unique via sequential suffix (spec 220 §5): alice ->
// alice2 -> alice3 … Read-only (AgentNamingClient.resolveName; null = free).
//
// GET /connect/name?label=<label>&exact=1 → claim the EXACT label or fail (spec 275
// MAM-D4). Returns { name, node, label } when free; { error:'taken', taken:true } when
// taken — NO suffix bump. Used by the home's multi-agent manager where the member types
// the precise name they want for each Smart Agent.
import { AgentNamingClient, namehash } from '@agenticprimitives/agent-naming';
import { json, type FnContext } from '../_lib/server-broker';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';

function sanitize(base: string): string {
  // Take the FIRST dot-segment first: a dotted base (e.g. `joe.impact`, if a caller passes a full name)
  // must NEVER be flattened into one label (`joeimpact`) by stripping the dot — that produced the
  // `joeimpact.impact` doubled-name bug. Then keep [a-z0-9-] only.
  const firstLabel = base.split('.')[0] ?? '';
  const s = firstLabel.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
  return s.length >= 3 ? s.slice(0, 24) : 'agent';
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const url = new URL(request.url);
  const naming = new AgentNamingClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
    chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry,
    universalResolver: CONTRACTS.agentNameUniversalResolver,
  });

  // spec 275 MAM-D4: exact-or-fail. The member named this agent deliberately; a taken
  // label is an error, NEVER a silent `<label>2` (MAM-INV-2 / ADR-0013 no fallback).
  const exact = url.searchParams.get('exact');
  if (exact === '1' || exact === 'true') {
    const label = sanitize(url.searchParams.get('label') ?? url.searchParams.get('base') ?? '');
    const name = `${label}.impact`;
    if (await naming.resolveName(name)) {
      return json({ error: 'taken', taken: true, label, name }, 409);
    }
    return json({ label, name, node: namehash(name) });
  }

  const base = sanitize(url.searchParams.get('base') ?? 'agent');
  for (let i = 1; i < 50; i++) {
    const candidate = i === 1 ? base : `${base}${i}`;
    const name = `${candidate}.impact`;
    if (!(await naming.resolveName(name))) {
      return json({ label: candidate, name, node: namehash(name) });
    }
  }
  return json({ error: 'no free label found' }, 409);
};
