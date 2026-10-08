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
import { protectingDomain } from './naming-ticket';
import { AGENT_NAME_PARENT, AGENT_NAME_PARENTS, CLAIMABLE_TLDS } from '../../src/lib/domain';

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
    rpcUrl: (env.RPC_URL || DEFAULT_RPC_URL),
    chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry,
    universalResolver: CONTRACTS.agentNameUniversalResolver,
  });

  // spec 346 migration — a label must be free under EVERY root a bare subdomain label may denote here
  // (`AGENT_NAME_PARENTS` ∪ the requested suffix), so `<label>.<zone>` keeps denoting exactly one home.
  const roots = [...new Set([tld, ...AGENT_NAME_PARENTS])];
  const labelTaken = async (label: string): Promise<boolean> => {
    for (const r of roots) if (await naming.resolveName(`${label}.${r}`)) return true;
    return false;
  };

  // spec 275 MAM-D4: exact-or-fail. The member named this agent deliberately; a taken
  // label is an error, NEVER a silent `<label>2` (MAM-INV-2 / ADR-0013 no fallback).
  const exact = url.searchParams.get('exact');
  // THE DOMAIN RULE, HERE TOO (2026-10-08). The naming gate refuses a label that is a real internet domain unless the
  // claimant has a verified email there (`domain_protected`, naming-ticket.ts). A free-name answer that ignores that
  // rule sends a ceremony to deploy an organization whose name it then cannot buy — 0xB992… exists unnamed because
  // `scripture` passed here and failed at the ticket. A label the gate will refuse is refused where the name is picked,
  // with the gate's own words, so an app's "which label?" (the skills app asks with exact=1) falls through to its
  // alternative BEFORE anything is deployed. A DNS check that could not run is said as such, never as "free".
  const protectedBy = async (label: string): Promise<Response | null> => {
    const { domain, unknown } = await protectingDomain(label);
    if (unknown && !domain) return json({ error: 'dns_unavailable', detail: 'The domain check could not run just now; try again in a moment.', label }, 503);
    if (domain) return json({ error: 'domain_protected', domain, label, name: `${label}.${tld}`, detail: `${label} is a domain. To claim ${label}.${tld} you need a verified email at ${domain} on this Home.`, need: 'email' }, 402);
    return null;
  };

  if (exact === '1' || exact === 'true') {
    const label = sanitize(url.searchParams.get('label') ?? url.searchParams.get('base') ?? '');
    const name = `${label}.${tld}`;
    if (await labelTaken(label)) {
      return json({ error: 'taken', taken: true, label, name }, 409);
    }
    const refused = await protectedBy(label);
    if (refused) return refused;
    return json({ label, name, node: namehash(name), tld });
  }

  const base = sanitize(url.searchParams.get('base') ?? 'agent');
  // The base itself under the domain rule is a refusal, not a bump: `scripture2.org` is not what anyone asked for.
  const baseRefused = await protectedBy(base);
  if (baseRefused) return baseRefused;
  for (let i = 1; i < 50; i++) {
    const candidate = i === 1 ? base : `${base}${i}`;
    const name = `${candidate}.${tld}`;
    if (!(await labelTaken(candidate))) {
      return json({ label: candidate, name, node: namehash(name), tld });
    }
  }
  return json({ error: 'no free label found' }, 409);
};
