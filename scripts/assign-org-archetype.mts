import { validateAgentHarnessDefinition } from '@agenticprimitives/capability-claims';
/**
 * Assign a registry archetype to a demo agent, as its steward.
 *
 *   ARCHETYPE=org-steward npx tsx scripts/assign-org-archetype.mts <stewardHandle> <agentAddress> [more pairs…]
 *   CONTEXT=texas-holdem ARCHETYPE=holdem-coach-bob npx tsx scripts/assign-org-archetype.mts bob <bob-coach.svc address>
 *
 * ARCHETYPE defaults to org-steward; treasury-steward gives a treasury its payment playbook — including
 * the spec 360 declared effects, WHICH IS WHY AN UNASSIGNED TREASURY PAYS SILENTLY: the effect resolver
 * reads the PAYER agent's playbook, and an agent with none has promised nothing.
 *
 * Same ceremony as assign-person-archetype.mts — the assignment is a vault record written by the
 * steward's own session through `/connect/channels`, and IT GRANTS NOTHING (spec 354 §1): the playbook
 * changes what the org's agent knows how to do (including telling both parties when its money moves,
 * spec 360); every act still waits on a mandate.
 */
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const REGISTRY = process.env.SKILLS_REGISTRY ?? 'https://skills-a2a-production.richardpedersen3.workers.dev';

const args = process.argv.slice(2);
if (args.length < 2 || args.length % 2) throw new Error('usage: assign-org-archetype.mts <stewardHandle> <orgAddress> [pairs…]');

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200) }; } };

const ARCHETYPE = process.env.ARCHETYPE ?? 'org-steward';
// CONTEXT names the registry context the archetype lives in: agentic-trust for the stewards, texas-holdem for a
// hold'em coaching service (`CONTEXT=texas-holdem ARCHETYPE=holdem-coach-bob … <bob> <bob-coach.svc's address>`).
const CONTEXT = process.env.CONTEXT ?? 'agentic-trust';
const def = await j(await fetch(`${REGISTRY}/context/contexts/${CONTEXT}/archetypes/${ARCHETYPE}/definition?fresh=${Date.now()}`));
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

for (let i = 0; i < args.length; i += 2) {
  const handle = args[i]!; const org = args[i + 1]!.toLowerCase();
  const si = await j(await fetch(`${HOME}/connect/demo-signin`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, client_id: 'demo-jp' }),
  }));
  if (!si.homeSession) { console.log(`${handle}: no session`); continue; }
  const out = await j(await fetch(`${HOME}/connect/channels`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` },
    body: JSON.stringify({ action: 'archetypeAssignmentPut', communityId: org, record }),
  }));
  console.log(`${handle} → ${org}: ${JSON.stringify(out).slice(0, 140)}`);
}
