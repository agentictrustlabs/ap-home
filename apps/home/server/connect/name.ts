// GET /connect/name?base=<label>[&tld=<suffix>] → the next free `<label>[N].<suffix>` +
// its namehash node. `tld` defaults to the legacy AGENT_NAME_PARENT (`impact`); a typed suffix
// (spec 346 — me/org/team/svc/workspace/treasury/registry) is accepted only when this deployment lists
// it in CLAIMABLE_TLDS (i.e. the typed roots exist on its chain). Unknown → 400, never a silent default. Forced-unique via sequential suffix (spec 220 §5): alice ->
// alice2 -> alice3 … Read-only (AgentNamingClient.resolveName; null = free).
//
// GET /connect/name?label=<label>&exact=1 → claim the EXACT label or fail (spec 275
// MAM-D4). Returns { name, node, label } when free; { error:'taken', taken:true } when
// taken — NO suffix bump. Used by the home's multi-agent manager where the member types
// the precise name they want for each Smart Agent.
import { AgentNamingClient, namehash, isAgentTld, canonicalTld } from '@agenticprimitives/agent-naming';
import { json, type FnContext } from '../_lib/server-broker';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { AGENT_NAME_PARENT, CLAIMABLE_TLDS } from '../../src/lib/domain';

/** The suffix this request claims under: the legacy parent by default; a typed suffix only when claimable here. */
function suffixFor(raw: string | null): { tld: string } | { error: string } {
  if (!raw) return { tld: AGENT_NAME_PARENT };
  const t = canonicalTld(raw.trim().toLowerCase()) ?? raw.trim().toLowerCase();
  if (t === AGENT_NAME_PARENT) return { tld: t };
  if (isAgentTld(t) && CLAIMABLE_TLDS.includes(t)) return { tld: t };
  return { error: `suffix ".${raw}" is not claimable on this deployment` };
}

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
  const suffix = suffixFor(url.searchParams.get('tld'));
  if ('error' in suffix) return json({ error: suffix.error }, 400);
  const { tld } = suffix;
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
    const name = `${label}.${tld}`;
    if (await naming.resolveName(name)) {
      return json({ error: 'taken', taken: true, label, name }, 409);
    }
    return json({ label, name, node: namehash(name) });
  }

  const base = sanitize(url.searchParams.get('base') ?? 'agent');
  for (let i = 1; i < 50; i++) {
    const candidate = i === 1 ? base : `${base}${i}`;
    const name = `${candidate}.${tld}`;
    if (!(await naming.resolveName(name))) {
      return json({ label: candidate, name, node: namehash(name), tld });
    }
  }
  return json({ error: 'no free label found' }, 409);
};
