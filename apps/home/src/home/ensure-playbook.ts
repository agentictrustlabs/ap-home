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
import { assignDefaultArchetype } from './default-archetype';

const done = new Set<string>();

export async function ensurePlaybook(agent: string, token: string): Promise<void> {
  const key = agent.toLowerCase();
  if (done.has(key)) return;
  done.add(key);
  try {
    const r = await fetch('/connect/channels', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'archetypeAssignmentGet', communityId: key }) });
    const b = (await r.json().catch(() => ({}))) as { ok?: boolean; record?: { archetypeId?: string; definitionDigest?: string } | null };
    if (r.ok && b.ok && b.record?.archetypeId && b.record.definitionDigest) return; // assigned — the person's choice stands
    if (!r.ok) { console.warn('[playbook] assignment could not be read; not assigning a default over an unknown'); return; }
    const a = await assignDefaultArchetype(key, 'person', token);
    console.info(a.ok ? `[playbook] this agent had no playbook — assigned the estate's default (${a.archetypeId}); change it on Behaviour → Playbook` : `[playbook] no playbook, and the default could not be assigned: ${a.reason} — the bare harness stands`);
  } catch (e) {
    console.warn('[playbook] self-heal skipped:', e instanceof Error ? e.message : String(e));
  }
}
