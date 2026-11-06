// THE DEFAULT PLAYBOOK FOLLOWS THE CORPUS, AT THE AGENT (owner, 2026-11-04: nobody should have to go back to their Home
// for their agent to learn something). An assignment is a digest-pinned SNAPSHOT in the agent's vault. The Home moves a
// default-playbook snapshot forward when the person next opens it (`ensure-playbook.ts`, the same rule: the person chose
// nothing, the estate did), but a person who only uses another app never opens it, and their agent refuses the new
// capability as one it does not offer. So the runtime reads the current compiled default in place of the snapshot.
//
// READ ONLY: the vault record is not touched, and no authority moves — a playbook narrows what is OFFERED, every act
// still waits on its mandate. A playbook the person chose themselves stands exactly as pinned. A registry that cannot be
// reached, or an answer that does not hash or validate, leaves the snapshot standing: never worse than before.
import { definitionDigest, validateAgentHarnessDefinition, type AgentHarnessDefinitionV1 } from '@agenticprimitives/capability-claims';

const REGISTRY = 'https://skills-a2a-production.richardpedersen3.workers.dev';
const BASE = { context: 'agentic-trust', archetype: 'person-steward' };
const TTL_MS = 5 * 60_000;
const FAILED_TTL_MS = 60_000;
const TIMEOUT_MS = 3_000;

type Compiled = { definition: AgentHarnessDefinitionV1; digest: string };
type Log = (line: string) => void;
interface Pack { context: string; archetype: string; organization?: string; organizationName?: string; roleName?: string }
interface Assignment { type?: string; definition?: AgentHarnessDefinitionV1; definitionDigest?: string; composedFrom?: { base?: { context?: string; archetype?: string; digest?: string }; packs?: Pack[] } }

const memo = new Map<string, { at: number; ttl: number; value: Compiled | null }>();
export const clearPlaybookMemo = (): void => memo.clear();

const trusted = (b: { definition?: AgentHarnessDefinitionV1; digest?: string }): Compiled | null =>
  b.definition && b.digest && definitionDigest(b.definition) === b.digest && validateAgentHarnessDefinition(b.definition).ok ? { definition: b.definition, digest: b.digest } : null;

async function remembered(key: string, compile: () => Promise<Compiled | null>, now: number): Promise<Compiled | null> {
  const hit = memo.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.value;
  const value = await compile().catch(() => null);
  memo.set(key, { at: now, ttl: value ? TTL_MS : FAILED_TTL_MS, value });
  return value;
}

const currentBase = (f: typeof fetch, now: number) => remembered('base', async () => {
  const r = await f(`${REGISTRY}/context/contexts/${BASE.context}/archetypes/${BASE.archetype}/definition`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  return r.ok ? trusted((await r.json()) as Compiled) : null;
}, now);

/** Mirrors the Home's `packHeading`: the composed instructions must read the same whichever side composed them. */
const heading = (p: Pack): string | undefined => {
  if (!p.roleName) return undefined;
  if (!p.organization) return `${p.roleName} (added by you)`;
  return `${p.roleName} at ${p.organizationName?.trim() || `${p.organization.slice(0, 6)}…${p.organization.slice(-4)}`}`;
};

/** A pack re-scoped to another kind of agent refuses the whole composition; it cannot be held on the new version. */
const refusedPack = (error: string): string | null => /^(\S+\/\S+) is for .+ agents and cannot be added to an? .+ playbook/.exec(error)?.[1] ?? null;

const composeOnCurrent = (packs: Pack[], baseDigest: string, f: typeof fetch, now: number) =>
  remembered(`${baseDigest}:${JSON.stringify(packs.map((p) => [p.context, p.archetype, heading(p)]))}`, async () => {
    let left = packs;
    for (let i = 0; i <= packs.length; i++) {
      const r = await f(`${REGISTRY}/context/compose`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({ base: BASE, packs: left.map((p) => ({ context: p.context, archetype: p.archetype, ...(heading(p) ? { as: heading(p) } : {}) })) }),
      });
      const b = (await r.json().catch(() => ({}))) as Compiled & { error?: string };
      if (r.ok) return trusted(b);
      const ref = refusedPack(String(b.error ?? ''));
      if (!ref || !left.some((p) => `${p.context}/${p.archetype}` === ref)) return null;
      left = left.filter((p) => `${p.context}/${p.archetype}` !== ref);
    }
    return null;
  }, now);

/** The assignment this agent should run under: the stored one, or the same one on the current default. */
export async function withCurrentDefault(raw: unknown, agent: string, log: Log = () => {}, f: typeof fetch = (...a) => fetch(...a), now = Date.now()): Promise<unknown> {
  if (!raw || typeof raw !== 'object') return raw;
  const rec = raw as Assignment;
  if (rec.type !== 'ap.archetype-assignment.v1' || !rec.definition || !rec.definitionDigest) return raw;
  const base = await currentBase(f, now);
  if (!base) return raw;
  const from = rec.composedFrom;
  const packs = from?.packs ?? [];
  let next: Compiled | null;
  if (from) {
    if (from.base?.context !== BASE.context || from.base?.archetype !== BASE.archetype) return raw; // a base they chose
    if (from.base.digest === base.digest) return raw;
    next = packs.length ? await composeOnCurrent(packs, base.digest, f, now) : base;
  } else {
    if (rec.definition.archetypeId !== base.definition.archetypeId) return raw; // a playbook they chose
    next = base;
  }
  if (!next || next.digest === rec.definitionDigest) return raw;
  log(`[playbook] ${agent}: runs the current default (${rec.definitionDigest.slice(0, 10)}… → ${next.digest.slice(0, 10)}…)`);
  return { ...rec, definition: next.definition, definitionDigest: next.digest, archetypeId: next.definition.archetypeId, archetypeVersion: next.definition.archetypeVersion };
}
