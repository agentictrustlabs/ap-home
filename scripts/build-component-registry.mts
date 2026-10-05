/**
 * Spec 398 §10.5 — THE HOME COMPONENT REGISTRY, shadcn-compatible, generated from the components that exist. Each item
 * ships with the CONTRACT it expects (which interaction fields / projections it renders, which A2A boundary it posts to)
 * and an executable example. INSTALLING A COMPONENT NEVER INSTALLS AUTHORITY (D07): an item carries no key, no grant,
 * no verb — it renders a contract's projections and posts to the app's `/a2a/*` boundary; the gate below refuses an
 * item whose source touches signing.
 *
 *   npx tsx scripts/build-component-registry.mts            writes apps/home/src/registry/registry.json
 *   npx tsx scripts/build-component-registry.mts --check    drift + authority scan (check:component-registry)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APP = 'apps/home';
const OUT = join(APP, 'src/registry/registry.json');
const HOMEPAGE = 'https://github.com/agentictrustlabs/agenticprimitives/blob/master/specs/398-agentic-primitives-ux-strategy.md';

interface Item {
  name: string; title: string; description: string;
  files: string[];
  /** The contract the component expects — spec 361 interaction fields and the projections it renders. */
  contract: { renders: string[]; expects?: string[]; posts?: string[] };
  example: string;
}

const ITEMS: Item[] = [
  { name: 'state-pill', title: 'State pill', description: 'One state vocabulary, everywhere (398 §5.1): the projected word for a run, task, endeavor, trigger or step, with effect-uncertain as its own tone.',
    files: ['src/components/portal/StatePill.tsx', 'src/home/run-state.ts'], contract: { renders: ['ProjectedRunStateV1 (@agenticprimitives/harness/run-state)'] },
    example: `<StatePill state={stateOf({ kind: 'run', outcome: 'suspended', awaiting: 'signature' })} native="suspended" />` },
  { name: 'basis-line', title: 'Basis line', description: 'Acting as · in · basis (custody | membership grant | delegation in hand | none) · what this act needs (398 §4.4). A role name is never a basis.',
    files: ['src/components/portal/BasisLine.tsx', 'src/lib/acting-basis.ts'], contract: { renders: ['actingBasis(...)'], expects: ['describeRequirement words for `needs`'] },
    example: `<BasisLine needs="send money as alice2.treasury, this request only" />` },
  { name: 'work-item-card', title: 'Work item', description: 'The accountable work item (398 §4.3): goal · owner · executors · status · conversation · artifacts · acceptance · cost — absent said absent.',
    files: ['src/components/portal/work/WorkItemCard.tsx', 'src/home/work-item.ts'], contract: { renders: ['WorkItemV1 from workItemOf(org, endeavorId, WorkDetailResponse)'] },
    example: `<WorkItemCard item={workItemOf(org, id, detail)!} org={org} />` },
  { name: 'run-controls', title: 'Run controls (cancel)', description: 'Pause · cancel · revoke · undo are four things (398 §5.3): the cancel control, saying what it is not.',
    files: ['src/components/portal/runs/RunControls.tsx'], contract: { renders: ['an unfinished run by runRef'], posts: ['/a2a/harness/cancel'] },
    example: `<RunControls token={session.token} addressee={agent} runRef={run.runRef} onCanceled={reload} />` },
  { name: 'run-inspector', title: 'Run inspector', description: 'Artifact-first (398 §5.2): outcome → artifacts → decisions → plan and per-step authority → execution detail → provenance; the retry affordance from the contract\'s idempotency.',
    files: ['src/components/portal/runs/RunInspector.tsx', 'src/components/portal/runs/RunTimeline.tsx', 'src/home/retry.ts'], contract: { renders: ['RunInspectorRecord (/a2a/harness/provenance format=record)', 'spans (/a2a/harness/spans)'], expects: ['interaction.result names the outcome component (361)'] },
    example: `<RunInspector token={session.token} addressee={agent} runRef={runRef} goal={row.intent.goal} />` },
  { name: 'attention-bar', title: 'Attention groups', description: 'What needs you, pinned in the inbox rail (398 §5.5): needs you (decisions + questions, open) · waiting · finished, folded; one card per object, one action set; unread is a filter on the conversations, never a group. Six filters stay the model.',
    files: ['src/components/portal/AttentionBar.tsx', 'src/home/attention.ts', 'src/home/today.ts', 'src/components/portal/chat/rail-date.ts'], contract: { renders: ['AttentionInputs → three folded groups (attentionGroups)'], expects: ['renderCaseActions for an inbox case (interaction.review, 361)'] },
    example: `<AttentionGroups inputs={inputs} token={t} addressee={me} onCanceled={drop} renderCaseActions={actionsFor} onOpenDm={open} onOpenCase={openCase} />` },
  { name: 'fleet-lines', title: 'Fleet boundary', description: 'M06 (398 §4.4): where an agent runs · what it may spend · what it holds — three lines, not an avatar.',
    files: ['src/components/portal/FleetLines.tsx'], contract: { renders: ['planes status + vault-key binding'], posts: ['/a2a/interactions/<sa>/status (read)', '/mcp-bind/custody/vault-key/is-bound (read)'] },
    example: `<FleetLines agent={org} token={session.token} stewardship />` },
  { name: 'roster', title: 'Roster', description: 'Per participant (398 §4.5): type · sponsor · responsibility · permissions in words · active work (§12-honest).',
    files: ['src/components/portal/MemberRoster.tsx', 'src/home/roster-contract.ts'], contract: { renders: ['RosterRow from rosterRows({ members, executors })'] },
    example: `<MemberRoster agent={org} title="Members" />` },
  { name: 'save-as-recipe', title: 'Save as recipe', description: 'A completed run as a draft SKILL.md in the Library (398 APUX-034): the runtime drafts (plan as steps, parties as roles, no key can reach it), the person saves; the draft says authority is requested anew.',
    files: ['src/components/portal/runs/SaveAsRecipe.tsx', 'src/home/recipe.ts'], contract: { renders: ['RecipeDraft (/a2a/harness/recipe)'], posts: ['/a2a/harness/recipe (read: the draft)', '/connect/library action=save (the person\'s act)'] },
    example: `<SaveAsRecipe token={session.token} addressee={agent} runRef={run.runRef} scope={scope} />` },
  { name: 'artifact-identity', title: 'Artifact identity', description: 'Version · author · sources · scope · work item · access method (owned locally | live remote | authorized replica | derived copy); share, publish, replicate as three acts (398 §6.2).',
    files: ['src/home/artifact-identity.ts'], contract: { renders: ['ArtifactIdentity from artifactIdentity(artifact, owner, publishable)'] },
    example: `const id = artifactIdentity(artifact, { sa: owner, vaultLabel: 'Person vault' }, publishable);` },
];

/** Signing, minting or a key in a registry item would be authority shipped as a component. Refused by name. */
const AUTHORITY = /signHashFor\(|mintMandate\(|mintApprovedMandate\(|privateKey|PRIVATE_KEY|persona-sign|wrangler secret|issue[A-Za-z]*Delegation\(/;

function build() {
  const items = ITEMS.map((it) => ({
    name: it.name, type: 'registry:component', title: it.title, description: it.description,
    files: it.files.map((f) => ({ path: f, type: f.includes('/components/') ? 'registry:component' : 'registry:lib', content: readFileSync(join(APP, f), 'utf8') })),
    dependencies: ['@agenticprimitives/harness', '@agenticprimitives/types'],
    meta: {
      contract: it.contract, example: it.example,
      authority: 'none — renders a contract\'s projections and posts only to the app\'s /a2a boundary; carries no key, no grant, no verb (398 D07)',
      spec: '398 §10.5',
    },
  }));
  return {
    $schema: 'https://ui.shadcn.com/schema/registry.json',
    name: 'agentic-primitives-home', homepage: HOMEPAGE,
    doctrine: 'Installing a component never installs authority (spec 398 D07): every item renders a contract\'s projections and posts to the app\'s A2A boundary; a mandate is signed where mandates are signed.',
    items,
  };
}

const check = process.argv.includes('--check');
const registry = build();
const findings: string[] = [];
for (const it of registry.items) for (const f of it.files) { const m = AUTHORITY.exec(f.content); if (m) findings.push(`${it.name}: ${f.path} touches authority (${m[0]})`); }
if (findings.length) { console.error(`✗ component registry — an item ships authority:\n${findings.map((f) => `  · ${f}`).join('\n')}`); process.exit(1); }
const text = `${JSON.stringify(registry, null, 2)}\n`;
if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== text) { console.error(`✗ check:component-registry — ${OUT} drifts from its sources; run \`pnpm build:component-registry\``); process.exit(1); }
  console.log(`✓ check:component-registry passed (${registry.items.length} items, none ships authority, registry current).`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT} (${registry.items.length} items)`);
}
