import { validateAgentHarnessDefinition } from '@agenticprimitives/capability-claims';
/**
 * Assign the Person Steward archetype to every demo persona's own agent.
 *
 *   npx tsx scripts/assign-person-archetype.mts [handle…]
 *
 * WHY A SCRIPT AND NOT A MIGRATION. An archetype assignment is a custodial act: it is written into the
 * agent's OWN vault, by that agent's own grant, and a person is the custodian of their own agent. There
 * is no server that may do this on their behalf, so the demo estate does it the way a person would —
 * with the persona's own session, through the same `/connect/channels` op the Home's ceremony uses.
 *
 * IT GRANTS NOTHING (spec 354 §1). The playbook changes what the agent knows how to do; every act it
 * takes still waits on a mandate the person signs for that request.
 */
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const REGISTRY = process.env.SKILLS_REGISTRY ?? 'https://skills-a2a-production.richardpedersen3.workers.dev';
const HANDLES = process.argv.slice(2).length ? process.argv.slice(2)
  : ['alice', 'bob', 'carol', 'dave', 'elena', 'nathan', 'david'];

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200) }; } };

// The definition is COMPILED FROM THE CORPUS, never authored here — this repo consumes definitions.
// ARCHETYPE=<id> assigns another person-kind archetype from the same catalog (spec 376 W2: person-steward-runtime).
const ARCHETYPE = process.env.ARCHETYPE ?? 'person-steward';
const def = await j(await fetch(`${REGISTRY}/context/contexts/agentic-trust/archetypes/${ARCHETYPE}/definition?fresh=${Date.now()}`));
if (!def?.definition) throw new Error(`no ${ARCHETYPE} definition: ${JSON.stringify(def).slice(0, 200)}`);
console.log(`${ARCHETYPE} digest ${def.digest} · ${def.definition.tools.length} tools · warnings ${def.warnings?.length ?? 0}`);
// A definition the harness would reject pins NOTHING: the agent runs bare, silently (seen 2026-09-28 — one contract's
// `result.kind: record` stripped a person's whole playbook). Validate with the harness's own validator first.
{ const v = validateAgentHarnessDefinition(def.definition); if (!v.ok) throw new Error(`refusing to pin an invalid ${ARCHETYPE} definition: ${(v.errors ?? []).slice(0, 5).join('; ')}`); }

const record = {
  type: 'ap.archetype-assignment.v1',
  archetypeId: def.definition.archetypeId,
  archetypeVersion: def.definition.archetypeVersion,
  definitionDigest: def.digest,
  definition: def.definition,
};

for (const handle of HANDLES) {
  try {
    const si = await j(await fetch(`${HOME}/connect/demo-signin`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, client_id: 'demo-jp' }),
    }));
    const token = si.homeSession; const agent = String(si.agent ?? '').toLowerCase();
    if (!token || !agent) { console.log(`${handle}: no session`); continue; }
    const out = await j(await fetch(`${HOME}/connect/channels`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'archetypeAssignmentPut', communityId: agent, record }),
    }));
    console.log(`${handle} ${agent}: ${JSON.stringify(out).slice(0, 120)}`);
  } catch (e) {
    console.log(`${handle}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
