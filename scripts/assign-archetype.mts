/**
 * ASSIGN AN ARCHETYPE to a managed agent — the K3 ceremony (spec 354), as a script.
 *
 *   npx tsx scripts/assign-archetype.mts --persona demo-admin --agent 0xBa73… \
 *     --context agentic-trust --archetype people-group-catalog [--dry-run]
 *
 * An archetype is a COMPILED BEHAVIOUR: the skills, tools and reasoning the agent runs under. Assigning one
 * changes what the agent knows how to do and grants it nothing — every act it takes still waits on a mandate
 * its steward signs for that request. The definition is authored in the skills app and compiled by the
 * registry; nothing here writes one (spec 354 — the compiler owns that, this repo consumes).
 *
 * Three checks before the write, each because skipping it produces an agent that reads as broken:
 *   · the definition must VALIDATE here, since run admission re-derives its digest on every read;
 *   · `applicableAgentTypes` must include this agent's type, which is the field run admission checks;
 *   · the digest is RECOMPUTED locally rather than trusted from the registry — a record whose digest does
 *     not match its definition is treated as ABSENT by `loadPlaybook`, so the agent would silently fall
 *     back to the bare harness and nothing would say why.
 *
 * The write goes through the STEWARD-gated `/connect/channels` door, the same one the Playbook page uses: a
 * service or org agent's behaviour is authored by its custodian, never by the agent's own session.
 */
import { validateAgentHarnessDefinition, definitionDigest, type AgentHarnessDefinitionV1 } from '@agenticprimitives/capability-claims';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const SKILLS = process.env.SKILLS_REGISTRY ?? 'https://skills-a2a-production.richardpedersen3.workers.dev';
const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const PERSONA = arg('persona');
const AGENT = (arg('agent') ?? '').toLowerCase();
const CONTEXT = arg('context') ?? 'agentic-trust';
const ARCHETYPE = arg('archetype');
const DRY = process.argv.includes('--dry-run');
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
if (!PERSONA) fail('--persona <steward handle> is required');
if (!/^0x[0-9a-f]{40}$/.test(AGENT)) fail('--agent <0x…> is required');
if (!ARCHETYPE) fail('--archetype <id> is required (list them: GET /context/contexts/<context>/archetypes)');

// ── the compiled definition, as the registry publishes it ──
const d = (await j(await fetch(`${SKILLS}/context/contexts/${CONTEXT}/archetypes/${ARCHETYPE}/definition`))) as
  { definition?: AgentHarnessDefinitionV1; digest?: string; warnings?: string[] };
if (!d?.definition) fail(`${CONTEXT}/${ARCHETYPE} has no compiled definition: ${JSON.stringify(d).slice(0, 250)}`);
const definition = d.definition;
const check = validateAgentHarnessDefinition(definition);
if (!check.ok) fail(`the compiled definition does not validate here: ${check.errors[0]}`);
const digest = definitionDigest(definition);

console.log(`── ${CONTEXT}/${ARCHETYPE} ──`);
console.log(`  archetype   ${definition.archetypeId} v${definition.archetypeVersion}`);
console.log(`  applies to  ${definition.applicableAgentTypes.join(', ')}`);
console.log(`  tools       ${(definition.tools ?? []).map((t) => (t as { id?: string; capabilityId?: string }).id ?? (t as { capabilityId?: string }).capabilityId).filter(Boolean).join(', ') || 'none declared'}`);
console.log(`  digest      ${digest}${d.digest && d.digest !== digest ? `  ✗ the registry says ${d.digest} — recomputed wins, and a mismatch is worth knowing about` : ''}`);
for (const w of d.warnings ?? []) console.log(`  warning     ${w}`);

const who = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: PERSONA, client_id: 'demo-web' }) }));
if (!who?.homeSession) fail(`${PERSONA} could not sign in at ${HOME}: ${JSON.stringify(who).slice(0, 200)}`);
const channels = async (body: unknown) => j(await fetch(`${HOME}/connect/channels`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${who.homeSession}` }, body: JSON.stringify(body) }));

// ── what the agent runs TODAY, so a switch is a diff and not a surprise ──
const current = await channels({ action: 'archetypeAssignmentGet', communityId: AGENT });
const now = current?.record as { archetypeId?: string; archetypeVersion?: string; definitionDigest?: string } | null | undefined;
console.log(`  today       ${now?.archetypeId ? `${now.archetypeId} v${now.archetypeVersion} (${String(now.definitionDigest).slice(0, 14)}…)` : current?.ok === true ? 'no archetype — the bare harness' : `unreadable: ${current?.error ?? JSON.stringify(current).slice(0, 160)}`}`);
if (now?.definitionDigest === digest) { console.log('\n✓ already assigned, digest for digest — nothing to write.'); process.exit(0); }

// THE AGENT'S TYPE IS THE CHECK THAT MATTERS, because it is the one run admission makes. The declared type
// is on the agent's own profile; a chartered-but-undeclared agent is read as its root's generic type.
const declared = (await j(await fetch(`${HOME}/connect/name-info?agent=${AGENT}`)).catch(() => null)) as { agentType?: string; declared?: { agentType?: string } } | null;
const agentType = (declared?.declared?.agentType ?? declared?.agentType ?? '').toLowerCase();
if (agentType && !definition.applicableAgentTypes.includes(agentType)) fail(`${ARCHETYPE} applies to ${definition.applicableAgentTypes.join('/')} and this agent is a ${agentType} — run admission would refuse the assignment`);
console.log(`  agent type  ${agentType || 'not declared on chain (unchecked)'}`);

if (DRY) { console.log('\n--dry-run: nothing was written.'); process.exit(0); }

const record = { type: 'ap.archetype-assignment.v1' as const, archetypeId: definition.archetypeId, archetypeVersion: definition.archetypeVersion, definitionDigest: digest, definition };
const put = await channels({ action: 'archetypeAssignmentPut', communityId: AGENT, record });
if (put?.ok !== true) fail(`the archetype write was refused: ${put?.error ?? JSON.stringify(put).slice(0, 300)}`);

// READ IT BACK. The write is into the agent's own vault and the runtime re-derives the digest on every
// read, so "the POST returned ok" is not the same fact as "the agent will run this".
const after = await channels({ action: 'archetypeAssignmentGet', communityId: AGENT });
const got = after?.record as { archetypeId?: string; definitionDigest?: string } | null | undefined;
if (got?.definitionDigest !== digest) fail(`written, but the read back does not match: ${JSON.stringify(got).slice(0, 250)}`);
console.log(`\n✓ ${definition.archetypeId} v${definition.archetypeVersion} assigned to ${AGENT} and read back, digest for digest.`);
console.log('  It grants nothing: every act still waits on a mandate its steward signs for that request.');
