// THE AGENT THAT WAS BORN BEFORE PLAYBOOKS — spec 354 §3, the self-heal.
//
// A person onboarded before `bornWithPlaybook` existed (or whose assignment was refused then, best-effort) has an
// agent with NO playbook: it runs the bare harness, which offers none of the contracts a domain author wrote —
// so a Library ask from an app they connected is refused `unknown_tool` and nothing explains why (rich-google2,
// 2026-09-21). The same is true of an assignment pinned to a definition that no longer validates.
//
// Once per session, when the portal opens on the person's OWN agent: read the assignment; when there is none, assign
// the estate's default for a person — the identical act onboarding performs, under the person's own session, written
// to their own vault, replaceable on Behaviour → Playbook. Behaviour, never authority: a playbook grants nothing.
// Best-effort and said: a registry that cannot be reached leaves the bare harness standing and a console line.
import { definitionDigest, validateAgentHarnessDefinition, type AgentHarnessDefinitionV1 } from '@agenticprimitives/capability-claims';
import { assignDefaultArchetype } from './default-archetype';

const done = new Set<string>();

export async function ensurePlaybook(agent: string, token: string): Promise<void> {
  const key = agent.toLowerCase();
  if (done.has(key)) return;
  done.add(key);
  try {
    const r = await fetch('/connect/channels', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'archetypeAssignmentGet', communityId: key }) });
    const b = (await r.json().catch(() => ({}))) as { ok?: boolean; record?: { archetypeId?: string; definitionDigest?: string; definition?: AgentHarnessDefinitionV1 } | null };
    if (!r.ok) { console.warn('[playbook] assignment could not be read; not assigning a default over an unknown'); return; }
    // THE RUNTIME'S OWN RULE (harness `loadPlaybook`): an assignment stands only when its embedded definition hashes to
    // the pinned digest AND validates. One that does not is IGNORED there — the agent runs bare with a record that
    // looks assigned (a definition compiled by an older corpus, before a field became required). Judged here the same
    // way, so a stale assignment is replaced rather than trusted by its presence.
    const rec = b.ok ? b.record : null;
    let why: string | null = null;
    if (!rec?.archetypeId || !rec.definitionDigest || !rec.definition) why = 'no playbook';
    else if (definitionDigest(rec.definition) !== rec.definitionDigest) why = `its definition does not hash to the pinned digest (${rec.archetypeId})`;
    else { const v = validateAgentHarnessDefinition(rec.definition); if (!v.ok) why = `its definition no longer validates (${rec.archetypeId}: ${v.errors[0]})`; }
    if (!why) return; // assigned and sound — the person's choice stands
    const a = await assignDefaultArchetype(key, 'person', token);
    console.info(a.ok ? `[playbook] ${why} — assigned the estate's default (${a.archetypeId}); change it on Behaviour → Playbook` : `[playbook] ${why}, and the default could not be assigned: ${a.reason} — the bare harness stands`);
  } catch (e) {
    console.warn('[playbook] self-heal skipped:', e instanceof Error ? e.message : String(e));
  }
}
