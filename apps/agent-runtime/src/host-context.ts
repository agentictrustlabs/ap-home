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

import { isCapabilityId } from '@agenticprimitives/capability-claims';
import { apAuthorityExtension, runProvenanceExtension } from '@agenticprimitives/a2a';
import { AgentNamingClient, parseSubdomainLabel, typedNameForLabel, parseTypedAgentHost as parseTypedHost, hostForName as hostFor, agentNameForHandle as nameForHandle } from '@agenticprimitives/agent-naming';
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

/** `alice.<zone>` → `alice` (the package's `parseSubdomainLabel`; apex, nesting and non-matching hosts → null). */
export function parseAgentSubdomain(hostname: string | undefined, baseDomain: string): string | null {
  return parseSubdomainLabel(hostname, baseDomain);
}

/** The `.agent` name for a subdomain label (`alice` → `alice.demo.agent`). */
export function agentNameForLabel(label: string): string {
  return `${label}.${AGENT_NAME_PARENT}`;
}

// The typed-host projection and its inverse (spec 346 §5) live in `@agenticprimitives/agent-naming` since
// spec 399 §4 — the Home's Card Studio derives the same host and once mirrored this file by hand. What stays
// here is THIS deployment's binding: its legacy parent (`impact`) as the default the package never names.
export function parseTypedAgentHost(hostname: string | undefined, baseDomain: string, parent: string = AGENT_NAME_PARENT): { label: string; name: string } | null {
  return parseTypedHost(hostname, baseDomain, parent);
}
export function hostForName(name: string, baseDomain: string, parents: readonly string[] = [AGENT_NAME_PARENT]): string | null {
  return hostFor(name, baseDomain, parents);
}
export function agentNameForHandle(handle: string, parent: string = AGENT_NAME_PARENT): string | null {
  return nameForHandle(handle, parent);
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
  const typedFirst = bare ? typedNameForLabel(norm) ?? undefined : undefined;
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
  // Spec 412 — THE PUBLIC SHELF: served to anyone, no credential, from what the owner marked public in the Library.
  // Mounted for every agent on the deployment (an owner with nothing public answers an empty shelf), so advertising
  // it is honest for all of them. A record, never authority: what comes back is a disclosure the owner already made.
  {
    id: 'library.public.list',
    name: 'The public shelf',
    description: 'List what this agent’s owner made public in their Library — folders, documents, and the signed release beside each. No credential: SendMessage with a data part { "skill": "library.public.list", "folder"?: string }; the answer is a message whose data part carries `files`.',
    tags: ['library', 'public', 'a2a'],
  },
  {
    id: 'library.public.read',
    name: 'Read a public document',
    description: 'Read one public document from this agent’s owner’s shelf: text decoded and bounded, an image as bytes, the release beside it. No credential: SendMessage with a data part { "skill": "library.public.read", "id"?: string, "name"?: string }. A document not on the shelf is answered as not on the shelf.',
    tags: ['library', 'public', 'a2a'],
  },
  // Spec 436 §5.5 — THE DAY'S PULSE a context agent keeps. Mounted for every agent, as the shelf is: an agent
  // that is written no pulse record answers that it has none, which is the true answer and not an error.
  // What comes back is counts, never a person — the records are aggregate by construction.
  {
    id: 'record.public.ask',
    name: 'Its record',
    description: 'How this agent’s runs have gone, as it reports it: how many ended each way, how complete what they left behind is, and who has judged them against which stated criteria — with every judgment carried as the evaluator’s own signed assessment, so a reader checks the evaluator rather than trusting the agent. Counts and signatures only: no run’s content, no asker, no name. Never a score — a registry lists, it does not rank. No credential: SendMessage with a data part { "skill": "record.public.ask" }.',
    tags: ['record', 'evidence', 'assessment', 'public', 'a2a'],
  },
  {
    id: 'pulse.public.ask',
    name: 'How things are going',
    description: 'Ask this agent how things have been going, answered only from the daily pulse records it keeps and with every record it used named. No credential: SendMessage with a data part { "skill": "pulse.public.ask", "question": string }; the answer is a message whose data part carries `answer`, `cited` and the `window` it read. An agent with no record for the window says so rather than reporting zero.',
    tags: ['pulse', 'public', 'a2a'],
  },
  // THE PERSON AS A PUBLISHER (publisher-contract.ts) — the publisher contract every content publisher answers
  // (publisher.describe · works · items · at-verse · near · changes), served over the owner's PUBLIC shelf to anyone
  // with no credential: what the owner marked public that carries scripture references or a location, in the same
  // envelope the scripture publisher and the publishing servers answer with. Her private marks never leave this way.
  ...([
    ['publisher.describe', 'Describe as a publisher', 'What this agent’s owner publishes under the publisher contract: the kinds of public works with scripture references or a location, their relations and bounds. No credential: SendMessage with a data part { "skill": "publisher.describe" }.'],
    ['publisher.works', 'Public works', 'The owner’s public works under the publisher contract — each with kind, item count and release. No credential: data part { "skill": "publisher.works", "kind"?: string }.'],
    ['publisher.items', 'A work’s items', 'One public work’s items in the publisher envelope (item, scripture references, location, release, licence), paged. No credential: data part { "skill": "publisher.items", "work": string, "cursor"?: string, "limit"?: number }.'],
    ['publisher.at-verse', 'At a verse', 'What the owner published at a verse (`verse`: John.3.16) or across a chapter (`span`: John.3), each with its scripture reference; `relation` and `kind` narrow. No credential: data part { "skill": "publisher.at-verse", "verse"?: string, "span"?: string, "relation"?: string, "kind"?: string }.'],
    ['publisher.near', 'Near a place', 'The owner’s public located items inside `bbox` [west, south, east, north] or within `radiusKm` of `point` [lon, lat]. No credential: data part { "skill": "publisher.near", "bbox"?: number[], "point"?: number[], "radiusKm"?: number }.'],
    ['publisher.changes', 'What changed', 'The owner’s public works saved or released since `since` (ms), oldest first, with the next cursor — for a registry that follows this publisher. No credential: data part { "skill": "publisher.changes", "since"?: number }.'],
  ] as const).map(([id, name, description]) => ({ id, name, description, tags: ['publisher', 'scripture', 'public', 'a2a'] })),
];

/** Merge the mounted peer skills into an agent's advertised set, dedup by id. Self-asserted labels win
 *  on collision: the agent's own description of a skill is more specific than this generic one. */
export function withMountedSkills(skills: A2aSkill[]): A2aSkill[] {
  const have = new Set(skills.map((s) => s.id));
  return [...skills, ...MOUNTED_PEER_SKILLS.filter((s) => !have.has(s.id))];
}

/**
 * CAPABILITY FAMILIES THE RUNTIME MOUNTS FROM THE AGENT'S OWN RECORDS, not from this Worker's code.
 *
 * `MOUNTED_PEER_SKILLS` above are unconditional — every bound host serves them. These are the other kind:
 * a catalog profile is mounted only when the agent's name record publishes an `atl:mcpEndpoint` and that
 * endpoint serves the profile, so the tools do not exist until a `tools/list` at plan time. That is why
 * they were missing from the card: the card builder resolves no binding and performs no such read, so an
 * agent whose entire job is catalog reads advertised none of them — `people-groups.svc` could answer
 * twenty-four questions and its card named none (observed live 2026-10-12).
 *
 * A PREFIX SET, for the same reason dispatch is a prefix test (`isPeopleGroupTool`): the member of a family
 * is known by its namespace, and a stateless Worker holds no registry of them.
 */
export const RECORD_MOUNTED_PREFIXES: readonly string[] = ['peoplegroup.', 'catalog.'];

/**
 * Advertise the record-mounted capabilities the agent's ASSIGNED PLAYBOOK declares.
 *
 * FROM THE PLAYBOOK, NOT FROM A LIVE `tools/list`, and that is the whole design decision here. The
 * playbook is a verified, digest-bound record of what this agent is equipped to do; a `tools/list` is the
 * liveness of one endpoint right now. Deriving a public card from the latter would make the card flicker
 * — twenty-four skills one minute and none the next, because a catalog blipped — and would put a network
 * read on the hot path of a public, cacheable surface. The card says what the agent is FOR; plan time
 * still fails closed when the endpoint cannot be read, which is where that check belongs.
 *
 * The description is the contract's own, so the card and the planner quote the same sentence.
 */
export function withRecordMountedSkills(
  skills: A2aSkill[],
  playbook?: { capabilityIds: Set<string>; tools?: Record<string, { id: string; description: string }> } | null,
): A2aSkill[] {
  if (!playbook) return skills;
  const have = new Set(skills.map((s) => s.id));
  const add: A2aSkill[] = [];
  for (const id of playbook.capabilityIds) {
    if (have.has(id) || !RECORD_MOUNTED_PREFIXES.some((p) => id.startsWith(p))) continue;
    have.add(id);
    const contract = playbook.tools?.[id];
    add.push({
      id,
      // The last dotted segment, spaced — `peoplegroup.engagement.overview` reads as "engagement overview".
      name: id.split('.').slice(1).join(' ') || id,
      ...(contract?.description ? { description: contract.description } : {}),
      tags: ['read', id.split('.')[0]!],
    });
  }
  // Sorted, so the card's bytes do not depend on a Set's insertion order: a released card is verified by
  // digest, and a list that reorders between builds would read as a changed card.
  add.sort((a, b) => a.id.localeCompare(b.id));
  return [...skills, ...add];
}

// Whether a stored value is already an ID or a human LABEL. `capability-claims` owns the rule — it
// owns the catalog, so it owns the vocabulary — and three apps each having their own copy is how two
// of them ended up demanding a CURIE colon the dotted ids do not have.

/**
 * Map the agent's publicly-asserted capability values to A2A skill cards (`skills[]` is the wire's name
 * for capabilities — ADR-0051).
 *
 * The stored value has TWO historical shapes and the id must survive both:
 *   • an ID (`registry.search`) — what `atl:capabilities` holds. Used VERBATIM. Slugifying it would
 *     publish `registry-search`, a different string from the one on chain and in ARD, which breaks the
 *     one guarantee an id has: that it is the same everywhere. (Observed live before this fix.)
 *   • a human LABEL (`treasury management`) — what legacy `atl:skills` holds. Slugified for the id,
 *     kept whole as the name.
 * The test is the value's shape, not which predicate it came from, so a legacy agent that happens to
 * have stored ids keeps them too.
 */
export function skillsFromLabels(csv: string | null | undefined): A2aSkill[] {
  if (!csv) return [];
  return csv.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 64).map((value) => ({
    id: isCapabilityId(value) ? value : value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    name: value,
    tags: ['capability'],
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
  // The edge path carries the agent's NAME — `POST <edge>/api/a2a/<handle>` is resolved by the naming grammar
  // (`agentNameForHandle`), and the handle rides in the signed GatewayAssertion. NOT `ctx.label`: since spec 346
  // §5 folded the type into one DNS label (2026-08-30) that is a hostname fragment
  // (`northern-colorado-field-workspace`), and advertising it made every card disagree with itself — the stored
  // card said `…/api/a2a/northern-colorado-field.workspace`, the live one said the label form, and validation
  // reported two divergences a steward could do nothing about.
  const handle = ctx.name ?? ctx.label;
  const messageEndpoint =
    edgeBase && handle
      ? `${edgeBase.replace(/\/$/, '')}/api/a2a/${handle}`
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
        // Spec 414 A1c — every run this agent answers says where its provenance is (PROV-AQ on the wire).
        // Unconditional: every run is recorded, and the pointer discloses nothing a reader without standing can use.
        runProvenanceExtension(),
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
