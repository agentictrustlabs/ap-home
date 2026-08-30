// A2A-by-subdomain host context (spec 231; pattern ported from agentic-trust
// `apps/atp-agent/src/worker.ts`). A request to `<handle>.impact-agent.io`
// identifies an A2A request for the agent named `<handle>.demo.agent`. The
// personal subdomain is the agent's single canonical endpoint — humans get the
// Connect SSO home, machines get this A2A endpoint.
//
// In production the subdomain origin is served by demo-sso (Pages), which owns
// the `*.impact-agent.io` custom domain and proxies the A2A paths here while
// injecting `X-Agent-Subdomain` (the resolved label) + `X-Public-Origin` (the
// public `https://<handle>.impact-agent.io`). For direct workers.dev / local
// access we parse the Host header ourselves.

import { apAuthorityExtension } from '@agenticprimitives/a2a';
import { AgentNamingClient, allAgentTlds, isAgentTld, parseAgentName, InvalidNameError } from '@agenticprimitives/agent-naming';
import type { Address } from '@agenticprimitives/types';

/** The TLD names are claimed under. `alice` → `alice.impact`. (Deployment convention — the
 *  package owns naming primitives; the concrete TLD is an app concern, so it lives here, not in
 *  agent-naming.) */
export const AGENT_NAME_PARENT = 'impact';

/** The public registrable base domain for personal endpoints. */
export const DEFAULT_PUBLIC_BASE_DOMAIN = 'impact-agent.io';

/**
 * The zones this deployment serves agents on, most-canonical FIRST (`A2A_PUBLIC_BASE_DOMAIN` accepts a
 * comma list). New cards publish at the first; the rest stay parseable so hosts named inside cards that are
 * ALREADY published and signed keep resolving through a zone move. Agents belong on a zone of their own — a
 * wildcard route on a zone shared with other Workers captures them (learned on faithnet.io, 2026-08-30).
 */
export function a2aBaseDomains(env: { A2A_PUBLIC_BASE_DOMAIN?: string }): string[] {
  const list = (env.A2A_PUBLIC_BASE_DOMAIN ?? DEFAULT_PUBLIC_BASE_DOMAIN).split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list : [DEFAULT_PUBLIC_BASE_DOMAIN];
}

/** Where NEW publications go: the canonical zone. */
export function a2aCanonicalDomain(env: { A2A_PUBLIC_BASE_DOMAIN?: string }): string {
  return a2aBaseDomains(env)[0]!;
}

/**
 * Extract a single-label subdomain from a hostname given the base domain.
 * `alice.impact-agent.io` + `impact-agent.io` → `alice`. The apex, nested
 * labels (`a.b.impact-agent.io`), and non-matching hosts → `null`.
 */
export function parseAgentSubdomain(hostname: string | undefined, baseDomain: string): string | null {
  if (!hostname) return null;
  const host = (hostname.split(':')[0] ?? '').toLowerCase();
  const base = baseDomain.toLowerCase();
  if (host === base) return null;
  if (!host.endsWith('.' + base)) return null;
  const label = host.slice(0, host.length - base.length - 1);
  if (!label || label.includes('.')) return null;
  return label;
}

/** The `.agent` name for a subdomain label (`alice` → `alice.demo.agent`). */
export function agentNameForLabel(label: string): string {
  return `${label}.${AGENT_NAME_PARENT}`;
}

/**
 * Typed-host projection (spec 346 §5), the inverse of agent-naming's `dnsHostForHandle` for the two host
 * shapes this deployment serves under ONE base zone:
 *   `<label>.<base>`          → `<label>.<AGENT_NAME_PARENT>`  (persons / legacy — the live pattern)
 *   `<label>.<type>.<base>`   → `<label>.<type>`               (typed roots hosted under the deployment zone:
 *                                                              `northern-colorado.team.<base>`, `discovery.registry.<base>`)
 * Anything else (apex, deeper nesting, an unknown type level) → null. The type level is a projection of the
 * suffix and is NEVER authority — `resolveTyped` re-validates the suffix against the on-chain record.
 */
/** `<label>-<type>` → the typed name it projects, or null when the label carries no known type suffix. */
function typedFromLabel(rest: string): { label: string; name: string } | null {
  for (const tld of allAgentTlds()) {
    const suffix = `-${tld}`;
    if (rest.endsWith(suffix) && rest.length > suffix.length) {
      const label = rest.slice(0, -suffix.length);
      return { label: `${label}.${tld}`, name: `${label}.${tld}` };
    }
  }
  return null;
}

export function parseTypedAgentHost(hostname: string | undefined, baseDomain: string, parent: string = AGENT_NAME_PARENT): { label: string; name: string } | null {
  if (!hostname) return null;
  const host = (hostname.split(':')[0] ?? '').toLowerCase();
  const base = baseDomain.toLowerCase();
  if (host === base || !host.endsWith('.' + base)) return null;
  const rest = host.slice(0, host.length - base.length - 1);
  const parts = rest.split('.');
  if (parts.length === 1 && parts[0]) {
    // spec 346 §5 (2026-08-30): a typed agent is ONE label, `<label>-<type>`, so the zone's existing
    // `*.<zone>` wildcard and its certificate cover every agent. The DNS label is returned RAW: a label may
    // read BOTH ways — `alice-home-church` is `alice-home.church` and also the legacy person/org name
    // `alice-home-church.impact` — so the choice belongs to `resolveAgentByLabel`, which tries an ordered
    // candidate set against the chain (one mechanism, ordered candidates — not a fallback, ADR-0013).
    return { label: parts[0], name: typedFromLabel(parts[0])?.name ?? `${parts[0]}.${parent}` };
  }
  // MIGRATION: the dotted form `<label>.<type>.<base>` was the convention until 2026-08-30 and is still
  // served, because cards published under it carry that URL in signed bytes. Nothing emits it any more
  // (`hostForName` below); drop this arm once those releases are superseded.
  if (parts.length === 2 && parts[0] && isAgentTld(parts[1]!)) return { label: `${parts[0]}.${parts[1]}`, name: `${parts[0]}.${parts[1]}` };
  return null;
}

/**
 * The inverse of `parseTypedAgentHost` (spec 346 §5): the public host this deployment serves an on-chain
 * name at. `<label>.<parent>` (parent ∈ the ordered person roots) → `<label>.<base>`; `<label>.<tld>` for
 * any other typed suffix → `<label>.<tld>.<base>`. Anything deeper or untyped → null (no host to publish at).
 * Used by the Card Studio to know WHERE a released card is served — a projection of the name, never authority.
 */
export function hostForName(name: string, baseDomain: string, parents: readonly string[] = [AGENT_NAME_PARENT]): string | null {
  const parts = name.trim().toLowerCase().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [label, tld] = parts as [string, string];
  if (parents.includes(tld)) return `${label}.${baseDomain}`;
  if (isAgentTld(tld)) return `${label}-${tld}.${baseDomain}`;
  return null;
}

/**
 * The on-chain name for an explicit handle (the edge path `POST /api/a2a/<handle>` and the injected
 * `X-Agent-Subdomain`). A single label is the legacy `<label>.<AGENT_NAME_PARENT>`; a typed handle
 * (`x.t`, `x.t@c.u`, `c.u/x.t`) or a legacy dotted name is parsed by the agent-naming grammar. Root and
 * type-node forms name no subject → null (generic context). One grammar, no guessing (ADR-0013).
 */
export function agentNameForHandle(handle: string, parent: string = AGENT_NAME_PARENT): string | null {
  const h = handle.trim().toLowerCase();
  if (!h) return null;
  if (!h.includes('.') && !h.includes('@') && !h.includes('/')) return `${h}.${parent}`;
  try {
    const p = parseAgentName(h);
    return p.kind === 'canonical' || p.kind === 'scoped' || p.kind === 'legacy' ? p.normalized : null;
  } catch (e) {
    if (e instanceof InvalidNameError) return null;
    throw e;
  }
}

export interface AgentHostContext {
  /** Subdomain label, e.g. `alice`. Null on the apex / generic endpoint. */
  label: string | null;
  /** Resolved canonical Smart Agent address, or null if the name has no agent. */
  agent: Address | null;
  /** The `.agent` name, or null on the apex. */
  name: string | null;
  /** Public endpoint origin (`https://alice.impact-agent.io`). */
  publicOrigin: string;
}

interface HostEnv {
  /** The legacy/person root a bare subdomain label maps to (default `impact`). */
  AGENT_NAME_PARENT?: string;
  /** spec 346 migration — an ORDERED list of person roots a bare label may denote (`me,impact`) while an
   *  estate moves to `.me`. The Home's claim route keeps a label unique across these roots, so resolving them
   *  in order is one lookup over a well-defined key, not a fallback between mechanisms. Overrides
   *  AGENT_NAME_PARENT when set. */
  AGENT_NAME_PARENTS?: string;
  RPC_URL?: string;
  CHAIN_ID?: string;
  AGENT_NAME_REGISTRY?: string;
  AGENT_NAME_UNIVERSAL_RESOLVER?: string;
  A2A_PUBLIC_BASE_DOMAIN?: string;
}

/**
 * Resolve the A2A agent for a request. Label source priority (ONE mechanism per
 * source — ADR-0013): the `X-Agent-Subdomain` header injected by the demo-sso
 * Pages proxy, else the request Host parsed against `A2A_PUBLIC_BASE_DOMAIN`.
 * Returns a context whose `agent` is null when there is no subdomain (generic
 * endpoint) or the name resolves to no agent.
 */
export async function resolveAgentHost(
  req: Request,
  env: HostEnv,
  requestOrigin: string,
): Promise<AgentHostContext> {
  const domains = a2aBaseDomains(env);
  const baseDomain = domains[0]!;
  const injected = req.headers.get('x-agent-subdomain');
  const hostname = new URL(req.url).hostname;
  // Parse against every zone we serve, not just the canonical one, so a host published before a zone move
  // still names its agent (the URL is inside the card's SIGNED bytes and cannot be edited in place).
  const fromHost = domains.map((d) => parseTypedAgentHost(hostname, d, env.AGENT_NAME_PARENT || AGENT_NAME_PARENT)).find((r) => r !== null) ?? null;
  const label = injected && injected.trim() ? injected.trim().toLowerCase() : fromHost?.label ?? null;
  // The public origin echoes the host that was ASKED for, so a card served from the old zone keeps naming it.
  const servedDomain = domains.find((d) => hostname === d || hostname.endsWith(`.${d}`)) ?? baseDomain;
  const publicOrigin = req.headers.get('x-public-origin')?.trim() || (label ? `https://${label}.${servedDomain}` : requestOrigin);
  return resolveAgentByLabel(label, env, publicOrigin);
}

/**
 * Resolve the A2A agent for an EXPLICIT subdomain label — the path the edge uses
 * (spec 288 §6): the edge addresses a specific agent via `POST /api/a2a/<handle>`,
 * the handle rides in the signed GatewayAssertion `path` (tamper-evident), and this
 * resolves `<handle>` → the canonical Smart Agent address the same way the Host path
 * does. Typed handles (`x.t`, `x.t@c.u`) resolve through the agent-naming grammar (spec 346); `null` /
 * unparseable / subject-less forms → the generic (no-agent) context.
 */
export async function resolveAgentByLabel(
  label: string | null,
  env: HostEnv,
  publicOrigin: string,
): Promise<AgentHostContext> {
  const norm = label && label.trim() ? label.trim().toLowerCase() : null;
  if (!norm) return { label: null, agent: null, name: null, publicOrigin };
  const bare = !norm.includes('.') && !norm.includes('@') && !norm.includes('/');
  const parents = (env.AGENT_NAME_PARENTS ?? env.AGENT_NAME_PARENT ?? AGENT_NAME_PARENT).split(',').map((p) => p.trim()).filter(Boolean);
  // A bare label denotes ONE home across the deployment's ordered person roots; anything else is one typed/legacy name.
  // spec 346 §5: a DNS label ending in `-<type>` reads as that typed name FIRST, then as a literal label under
  // the ordered roots — `alice-home-church` is `alice-home.church` before it is `alice-home-church.impact`.
  // Both are real names on this estate, so the host asks the chain in that order rather than guessing once.
  const typedFirst = bare ? typedFromLabel(norm)?.name : undefined;
  const candidates = bare ? [...(typedFirst ? [typedFirst] : []), ...parents.map((p) => `${norm}.${p}`)] : [agentNameForHandle(norm, parents[0] ?? AGENT_NAME_PARENT)].filter((n): n is string => !!n);
  if (candidates.length === 0) return { label: null, agent: null, name: null, publicOrigin };

  if (env.RPC_URL && env.CHAIN_ID && env.AGENT_NAME_REGISTRY && env.AGENT_NAME_UNIVERSAL_RESOLVER) {
    const client = new AgentNamingClient({
      rpcUrl: env.RPC_URL,
      chainId: Number(env.CHAIN_ID),
      registry: env.AGENT_NAME_REGISTRY as `0x${string}`,
      universalResolver: env.AGENT_NAME_UNIVERSAL_RESOLVER as `0x${string}`,
    });
    for (const name of candidates) {
      const agent = await client.resolveName(name);
      if (agent) return { label: norm, agent, name, publicOrigin };
    }
  }
  return { label: norm, agent: null, name: candidates[0]!, publicOrigin };
}

/** One A2A skill-card entry (A2A protocol shape). */
export interface A2aSkill { id: string; name: string; description?: string; tags?: string[] }

/** spec 329 §3 — the `discussion.consult` card entry for a PERSON agent with ≥1 active
 *  consultability delegation. Surfaced the same way `atl:skills` labels surface (spec 282):
 *  a card DESCRIPTION, never authority — reachability is the member's delegation gate alone. */
export const CONSULT_SKILL_CARD: A2aSkill = { id: 'discussion.consult', name: 'Discussion consult', tags: ['skill'] };

/** Append the consult skill card iff the agent is consultable somewhere (dedup-safe). */
export function withConsultSkill(skills: A2aSkill[], consultable: boolean): A2aSkill[] {
  if (!consultable || skills.some((s) => s.id === CONSULT_SKILL_CARD.id)) return skills;
  return [...skills, CONSULT_SKILL_CARD];
}

/**
 * THE PEER-CALLABLE SKILLS THIS RUNTIME MOUNTS (spec 341 §2.3).
 *
 * The Card advertised ONLY the agent's self-asserted `atl:skills` labels, and every bound agent served
 * `skills: []` because almost nobody sets that property. Meanwhile `makeMessagingSkills` mounts three
 * handlers on every agent's task runtime. So the Card omitted the entire messaging rail, and the §2 exit
 * criterion — *a third-party agent, reading only the public Card, can invoke `messaging.deliver`* —
 * could not be met by any agent on the deployment.
 *
 * These are MOUNTED facts, not claims: they are registered for every agent by `makeMessagingSkills`, so
 * advertising them is honest for all of them. A skill that stops being mounted MUST leave this list —
 * an over-claiming Card is worse than a silent one, because a peer builds against it and fails at the
 * gate with an authorization error that has nothing to do with authorization.
 *
 * A CARD ENTRY IS A DESCRIPTION, NEVER AUTHORITY (ADR-0041). Learning that `messaging.deliver` exists
 * tells a peer what to send; it grants nothing. Reaching it still requires a delegation naming this
 * agent in `allowedTargets` and the skill's selector in `allowedMethods`, verified on-chain per message.
 */
export const MOUNTED_PEER_SKILLS: A2aSkill[] = [
  {
    id: 'messaging.deliver',
    name: 'Deliver a message',
    description: 'Admit a signed message envelope into this agent’s inbox. Requires a delegation scoped to this agent and this skill; a message is never authority.',
    tags: ['messaging', 'a2a'],
  },
  {
    id: 'interactions.respond',
    name: 'Respond to an interaction',
    description: 'Deliver a response within an existing interaction. Same authorization shape as messaging.deliver.',
    tags: ['interactions', 'a2a'],
  },
  {
    id: 'org.apply',
    name: 'Apply to join',
    description: 'Submit a membership application to this organization. Anyone may apply; applying confers nothing, and approval creates no membership — the member writes their own on join.',
    tags: ['membership', 'a2a'],
  },
  {
    id: 'interactions.deliverCredential',
    name: 'Deliver a credential',
    description: 'Deliver a verifiable credential into this agent’s inbox. Admission is not acceptance — holding a credential grants nothing here.',
    tags: ['interactions', 'credentials', 'a2a'],
  },
];

/** Merge the mounted peer skills into an agent's advertised set, dedup by id. Self-asserted labels win
 *  on collision: the agent's own description of a skill is more specific than this generic one. */
export function withMountedSkills(skills: A2aSkill[]): A2aSkill[] {
  const have = new Set(skills.map((s) => s.id));
  return [...skills, ...MOUNTED_PEER_SKILLS.filter((s) => !have.has(s.id))];
}

/** Map an agent's publicly-asserted skill labels (spec 282 `atl:skills`, comma-joined) to A2A skill cards. */
export function skillsFromLabels(csv: string | null | undefined): A2aSkill[] {
  if (!csv) return [];
  return csv.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 64).map((label) => ({
    id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    name: label,
    tags: ['skill'],
  }));
}

/**
 * Build an A2A v1.0 AgentCard (shape ported from agentic-trust atp-agent
 * `buildAgentCard`). Agent-bound when `ctx.agent` is set; generic otherwise.
 * `skills` are the agent's PUBLICLY-ASSERTED skills (spec 282) — the same `atl:skills`
 * the discovery matcher ranks on, surfaced here on the standard A2A card.
 */
export function buildA2aAgentCard(
  ctx: AgentHostContext,
  chainId: number,
  skills: A2aSkill[] = [],
  // spec 288 §6 — when the deployment requires edge admission, advertise the EDGE endpoint
  // (`<edge>/api/a2a/<handle>`) as the agent's message endpoint so discovering agents reach
  // this agent THROUGH the edge (which mints the GatewayAssertion). Omit ⇒ the direct subdomain
  // endpoint (edge-less / advisory deployments).
  edgeBase?: string,
  // skill-provenance/v1 — advertise that this agent's artifacts may carry a
  // verifiable skill-provenance manifest (set when SKILLS_CORPUS_URL is configured).
  provenanceEnabled = false,
): Record<string, unknown> {
  const origin = ctx.publicOrigin.replace(/\/$/, '');
  const messageEndpoint =
    edgeBase && ctx.label
      ? `${edgeBase.replace(/\/$/, '')}/api/a2a/${ctx.label}`
      : `${origin}/api/a2a`;
  const bound = Boolean(ctx.agent);
  return {
    protocolVersion: '1.0',
    name: bound ? (ctx.name ?? ctx.label) : 'Agentic Connect A2A',
    description: bound
      ? `A2A endpoint for ${ctx.name} (Smart Agent ${ctx.agent}).`
      : 'Agent-to-Agent endpoint. Per-agent endpoints are served on personal subdomains.',
    version: '0.1.0',
    // Canonical Smart Agent identity (ADR-0010) — the address IS the agent.
    agentAddress: ctx.agent ?? null,
    agentName: ctx.name ?? null,
    supportedInterfaces: [{ url: messageEndpoint, protocolBinding: 'JSONRPC' }],
    provider: { organization: 'Agentic Connect', url: origin },
    capabilities: {
      // Honest flags (ADR-0059): this host mounts no SSE transport and wires no push sender, so it
      // says so. Spec 341 §3 makes one of these true BEFORE the Home's read cutover, because a Card
      // declaring neither leaves polling as the only mechanism.
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: [
        // ADR-0059 / spec 341 §2.1 — how to authenticate, on the PUBLIC card, unconditionally. Without
        // this a peer learns which skills exist and nothing about becoming allowed to call them, which
        // is what made spec 341's success test ("an external agent uses the same skills the Home
        // uses") unreachable. Unlike the provenance and x402 extensions this is NOT conditional: it
        // leaks nothing, and hiding it would defeat its only purpose.
        apAuthorityExtension({
          methods: ['delegation', 'session-wire', 'mandate'],
          chain: `eip155:${chainId}`,
        }),
        ...(provenanceEnabled
          ? [
              {
                uri: 'https://agentictrust.io/a2a/extensions/skill-provenance/v1',
                required: false,
                description: 'artifacts may carry a verifiable skill-provenance manifest (who-did-what-when)',
              },
            ]
          : []),
      ],
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills,
    supportsExtendedAgentCard: false,
    chainId,
  };
}
