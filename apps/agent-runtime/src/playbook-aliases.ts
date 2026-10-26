// PLAYBOOK ALIASES — the capability ids a stored playbook may still name from before a rename, read as the ids the
// runtime runs today. A playbook is compiled from an archetype and kept in the agent's vault; it is not rewritten when a
// capability is renamed, so without this an agent whose playbook says `person.contact.invite` would silently stop being
// offered "add a friend" (spec 401 §10 renamed it `person.friend.add`). Behaviour only: the playbook narrows what is
// OFFERED; the mandate gate is untouched, and an alias never adds a capability the playbook did not name.
import { loadPlaybook as loadStoredPlaybook } from '@agenticprimitives/harness';

/** Old id → the id it now is. One direction; never a second name for a live capability. */
export const CAPABILITY_ALIASES: Readonly<Record<string, string>> = {
  'person.contact.invite': 'person.friend.add',
  'person.contact.remove': 'person.friend.remove',
  // The one-sided list is gone; what a person asks it for is their friends.
  'person.contact.list': 'person.friend.list',
};

/** The arguments a renamed capability now names (old arg → new arg), per new id. */
const ARG_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'person.friend.add': { contact: 'friend', role: 'type' },
  'person.friend.remove': { contact: 'friend' },
};

export const canonicalCapabilityId = (id: string): string => CAPABILITY_ALIASES[id] ?? id;

/** A step's arguments under the capability's current argument names (a run parked before the rename carries the old). */
export function canonicalArgs(toolId: string, args: Record<string, unknown>): Record<string, unknown> {
  const map = ARG_ALIASES[canonicalCapabilityId(toolId)];
  if (!map) return args;
  const out: Record<string, unknown> = { ...args };
  for (const [from, to] of Object.entries(map)) if (from in out && !(to in out)) { out[to] = out[from]; delete out[from]; }
  return out;
}

type Scope = NonNullable<Awaited<ReturnType<typeof loadStoredPlaybook>>>;

/** A loaded playbook with every aliased id read as its current id — capability ids, tool contracts (their argument
 *  names too), specialists and declared effects. A current id already present wins over an aliased one. */
export function withCapabilityAliases<T extends Scope | null>(pb: T): T {
  if (!pb) return pb;
  const capabilityIds = new Set([...pb.capabilityIds].map(canonicalCapabilityId));
  let tools = pb.tools;
  if (tools) {
    const next: NonNullable<Scope['tools']> = {};
    for (const [id, t] of Object.entries(tools)) {
      const to = canonicalCapabilityId(id);
      if (to !== id && tools[to]) continue;
      const argMap = ARG_ALIASES[to] ?? {};
      const cap = t.capability ? { ...t.capability, id: canonicalCapabilityId(t.capability.id), ...(t.capability.resourceArg && argMap[t.capability.resourceArg] ? { resourceArg: argMap[t.capability.resourceArg] } : {}) } : undefined;
      next[to] = { ...t, id: to, ...(cap ? { capability: cap } : {}) };
    }
    tools = next;
  }
  const specialists = pb.specialists?.map((s) => ({ ...s, capability: canonicalCapabilityId(s.capability) }));
  const declaredEffects = pb.declaredEffects ? Object.fromEntries(Object.entries(pb.declaredEffects).map(([id, v]) => [canonicalCapabilityId(id), v])) : undefined;
  return { ...pb, capabilityIds, ...(tools ? { tools } : {}), ...(specialists ? { specialists } : {}), ...(declaredEffects ? { declaredEffects } : {}) } as T;
}

/** `loadPlaybook`, with the aliases applied — the one loader this runtime uses. */
export async function loadPlaybook(...args: Parameters<typeof loadStoredPlaybook>): Promise<Awaited<ReturnType<typeof loadStoredPlaybook>>> {
  return withCapabilityAliases(await loadStoredPlaybook(...args));
}
