// MESSAGING SCOPE CLASSES — what an entry in a messaging wire's `allowedTargets` may MEAN.
//
// A wire that enumerates person addresses is an N×N snapshot: every member re-signs whenever anyone
// joins, and a roster frozen at signing time is stale the moment it matters. The person's consent is
// not "these forty addresses" — it is "my community" or "anyone with a public name". So a target entry
// is read as one of three things, checked in one pass (no fallback chain — a single caveat with set
// semantics, evaluated once):
//
//   · a person address           — exactly that counterparty (the existing 1:1 approve);
//   · THIS deployment's naming registry — any agent holding a VALID name there, provided the SENDER
//     holds one too. A public name is an accountable, revocable identity; nameless agents can never
//     satisfy the sender side, so they fall through to…
//   · an organization SA         — CURRENT members of that org (live roster, both sender and
//     recipient), so a new joiner is reachable because they joined and a kick severs reach instantly.
//
// ONLY the three messaging skills read scopes (`MESSAGING_SCOPE_SKILLS`). Everything else — org.apply,
// consult, endeavors, payments — keeps FR-4.2's exact-address rule. A messaging wire always carries
// `allowedMethods`, so `hasStewardshipShape` (which requires its ABSENCE) can never mistake a
// registry-scoped messaging wire for a stewardship wire.
//
// FAIL-CLOSED: an unreadable roster, an unresolvable name, or an unconfigured registry answers
// "not covered" — never a weaker check (ADR-0013).
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import type { Address } from 'viem';
import { internalHeaders } from './internal-marker.js';

/** The skills whose `allowedTargets` admit scope classes. Everything else is exact-match only. */
export const MESSAGING_SCOPE_SKILLS: ReadonlySet<string> = new Set([
  'messaging.deliver',
  'interactions.respond',
  'interactions.deliverCredential',
]);

/** How many non-exact target entries we will treat as org candidates. A wire is a handful of scopes,
 *  not a directory — the bound keeps a hostile 100-entry wire from buying 100 roster reads. */
const MAX_ORG_LOOKUPS = 6;

export interface MessagingScopeDeps {
  /** The naming-registry address whose presence in targets means "any named agent" ('' ⇒ scope inert). */
  namingRegistry: string;
  /** Does this agent hold a valid (current, on-chain) name? Throw ⇒ treated as no. */
  isNamed(agent: Address): Promise<boolean>;
  /** Are ALL of `agents` current, proven, non-tombstoned members of `org`? Throw ⇒ treated as no. */
  orgCoversAll(org: Address, agents: readonly Address[]): Promise<boolean>;
}

export interface MessagingScopeQuery {
  targets: readonly string[];
  /** The person the wire speaks FOR — the delegation's delegator. */
  sender: string;
  /** The agent being delivered TO. */
  recipient: string;
  skill: string;
}

/**
 * Is `recipient` covered by this wire's targets, beyond an exact address match?
 * The caller checks exact match first; this answers only the class question.
 */
export async function messagingScopeCovers(deps: MessagingScopeDeps, q: MessagingScopeQuery): Promise<boolean> {
  if (!MESSAGING_SCOPE_SKILLS.has(q.skill)) return false;
  const sender = q.sender.toLowerCase() as Address;
  const recipient = q.recipient.toLowerCase() as Address;
  const registry = deps.namingRegistry.toLowerCase();
  const targets = [...new Set(q.targets.map((t) => t.toLowerCase()))];

  // Named-to-named: the registry entry means "anyone with a valid public name" — and the sender must
  // hold one too, which is the whole accountability of the class.
  if (registry && /^0x[0-9a-f]{40}$/.test(registry) && targets.includes(registry)) {
    const [senderNamed, recipientNamed] = await Promise.all([
      deps.isNamed(sender).catch(() => false),
      deps.isNamed(recipient).catch(() => false),
    ]);
    if (senderNamed && recipientNamed) return true;
  }

  // Community: any remaining entry may be an org whose CURRENT roster contains both parties. An entry
  // that is actually a person address answers "no roster" and simply does not cover.
  const orgCandidates = targets
    .filter((t) => t !== registry && t !== recipient && t !== sender && /^0x[0-9a-f]{40}$/.test(t))
    .slice(0, MAX_ORG_LOOKUPS);
  for (const org of orgCandidates) {
    if (await deps.orgCoversAll(org as Address, [sender, recipient]).catch(() => false)) return true;
  }
  return false;
}

interface ScopeEnv {
  RPC_URL?: string;
  CHAIN_ID?: string | number;
  AGENT_NAME_REGISTRY?: string;
  AGENT_NAME_UNIVERSAL_RESOLVER?: string;
  INTERACTIONS: DurableObjectNamespace;
  [k: string]: unknown;
}

/** The live deps: on-chain reverse resolution for namedness, and the org's own InteractionsDO —
 *  the single reader of its directory — for the roster. */
export function messagingScopeDepsFromEnv(env: ScopeEnv): MessagingScopeDeps {
  const registry = (env.AGENT_NAME_REGISTRY ?? '').toLowerCase();
  return {
    namingRegistry: registry,
    isNamed: async (agent) => {
      if (!env.RPC_URL || !registry || !env.AGENT_NAME_UNIVERSAL_RESOLVER) return false;
      const name = await new AgentNamingClient({
        rpcUrl: env.RPC_URL,
        chainId: Number(env.CHAIN_ID ?? 84532),
        registry: registry as Address,
        universalResolver: env.AGENT_NAME_UNIVERSAL_RESOLVER as Address,
      }).reverseResolve(agent);
      return !!name;
    },
    orgCoversAll: async (org, agents) => {
      const stub = env.INTERACTIONS.get(env.INTERACTIONS.idFromName(org.toLowerCase()));
      const resp = await stub.fetch(new Request(`https://do/interactions/${org.toLowerCase()}/internal.member.current`, {
        method: 'POST',
        headers: internalHeaders(env as never),
        body: JSON.stringify({ agents }),
      }));
      const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; current?: string[] };
      if (!resp.ok || !out.ok || !Array.isArray(out.current)) return false;
      const current = new Set(out.current.map((a) => a.toLowerCase()));
      return agents.every((a) => current.has(a.toLowerCase()));
    },
  };
}
