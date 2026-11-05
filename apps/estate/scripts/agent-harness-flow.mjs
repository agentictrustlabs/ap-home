// Draws the agent-harness flow picture for /architecture/agent-harness. The SVG in assets/architecture/ is this script's output:
//   node scripts/agent-harness-flow.mjs assets/architecture/agent-harness-flow.svg
// The PNG beside it (the link preview) is that SVG rendered at 2x in a browser.
// The numbered tiles are the steps the page lists beside the picture; their centres are repeated in src/architecture.ts (`at`).
import { C, I, picture } from './picture-kit.mjs';
const W = 1460, H = 960, ROW = 470, S = 64;
const { out, esc, tile, arrow, note, finish } = picture(W, H);

// ── frame and titles
out.push(`<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>`);
out.push(`<text x="40" y="52" class="h">How an ask runs at an agent</text>`);
out.push(`<text x="40" y="78" class="s" text-anchor="start">The agent harness of a faithnet Home, with the skills that flow into it. Intelligence may be probabilistic. Authority must not be.</text>`);

// ── main row positions
const X = { asker: 72, admit: 186, playbook: 300, ground: 414, judge: 528, plan: 642, check: 756, auth: 900, exec: 1016, receipt: 1132, answer: 1262, back: 1378 };
const h = S / 2 + 8;
const hop = (a, b) => arrow(`M${X[a] + h} ${ROW}H${X[b] - h - 4}`);
const t = (x, y, color, icon, name, sub, o = {}) => tile(x, y, color, icon, name, sub, { size: S, ...o });

// the per-step box
out.push(`<rect x="${X.auth - 66}" y="${ROW - 86}" width="${X.receipt - X.auth + 132}" height="196" rx="20" fill="none" stroke="${C.dash}" stroke-width="2" stroke-dasharray="7 7"/>`);
out.push(`<text x="${X.auth - 50}" y="${ROW - 62}" text-anchor="start" class="b">FOR EVERY STEP</text>`);

for (const [a, b] of [['asker', 'admit'], ['admit', 'playbook'], ['playbook', 'ground'], ['ground', 'judge'], ['judge', 'plan'], ['plan', 'check'], ['check', 'auth'], ['auth', 'exec'], ['exec', 'receipt'], ['receipt', 'answer'], ['answer', 'back']]) hop(a, b);
t(X.asker, ROW, '#64748b', 'person', 'Asker', ['person, app, agent']);
t(X.admit, ROW, '#8b5cf6', 'door', 'Admit', ['who is asking'], { n: 1 });
t(X.playbook, ROW, '#3b82f6', 'book', 'Playbook', ['pinned by digest'], { n: 2 });
t(X.ground, ROW, '#14b8a6', 'target', 'Ground', ['read by code'], { n: 3 });
t(X.judge, ROW, '#ef4444', 'scales', 'Judge', ['one skill, or none'], { n: 4 });
t(X.plan, ROW, '#f59e0b', 'plan', 'Plan', ['around the pick'], { n: 5 });
t(X.check, ROW, '#eab308', 'check', 'Check the plan', ['rules, no model'], { n: 6 });
t(X.auth, ROW, '#22c55e', 'key', 'Authority', ['a signed mandate'], { n: 7 });
t(X.exec, ROW, '#0ea5e9', 'play', 'Execute', ['once'], { n: 8 });
t(X.receipt, ROW, '#6366f1', 'receipt', 'Receipt', ['what ran'], { n: 9 });
t(X.answer, ROW, '#3b82f6', 'chat', 'Answer', ['checked'], { n: 10 });
t(X.back, ROW, '#64748b', 'person', 'Asker', ['answer or prompt']);

// ── skills flow in (top lane)
const TOP = 196;
out.push(`<text x="40" y="${TOP - 62}" class="b" text-anchor="start" style="fill:${C.skill}">SKILLS FLOW IN</text>`);
const K = { file: 72, registry: 216, archetype: 360, ontology: 504 };
t(K.file, TOP, C.skill, 'file', 'SKILL.md', ['by its author'], { outline: true });
t(K.registry, TOP, C.skill, 'stack', 'Skills registry', ['with a commitment'], { outline: true });
t(K.archetype, TOP, C.skill, 'box', 'Archetype', ['one digest'], { outline: true });
t(K.ontology, TOP, C.skill, 'graph', 'Domain ontology', ['what each covers'], { outline: true });
arrow(`M${K.file + h} ${TOP}H${K.registry - h - 4}`, { color: C.skill });
arrow(`M${K.registry + h} ${TOP}H${K.archetype - h - 4}`, { color: C.skill });
arrow(`M${K.ontology - h} ${TOP}H${K.archetype + h + 4}`, { color: C.skill });
// archetype → playbook (assigned)
arrow(`M${K.archetype} ${TOP + 90}V314Q${K.archetype} 330 ${K.archetype - 16} 330H${X.playbook + 16}Q${X.playbook} 330 ${X.playbook} 346V${ROW - h - 4}`, { color: C.skill });
note(X.playbook - 12, 366, ['assigned by the', "agent's custodian"], { anchor: 'end', color: C.skill });
// playbook → judge: the cards (an arc just above the row)
arrow(`M${X.playbook + 22} ${ROW - h}V${ROW - 76}Q${X.playbook + 22} ${ROW - 92} ${X.playbook + 38} ${ROW - 92}H${X.judge - 16}Q${X.judge} ${ROW - 92} ${X.judge} ${ROW - 76}V${ROW - h - 4}`, { color: C.skill, dash: true });
note(X.playbook + 44, ROW - 102, ["each skill's card"], { anchor: 'start', color: C.skill });
// registry → execute: the body, by pinned digest
arrow(`M${K.registry} ${TOP - h}V120Q${K.registry} 104 ${K.registry + 16} 104H${X.exec - 16}Q${X.exec} 104 ${X.exec} 120V${ROW - h - 4}`, { color: C.skill, dash: true });
note(X.plan + 60, 126, ["the skill's body, read when its step runs, by the digest the playbook pinned"], { color: C.skill });

// ── below the row
const LOW = 668, D = ROW + 94;
// judge → planner model → plan
t(X.judge, LOW, '#f59e0b', 'spark', 'Planner model', ['when no skill fits'], { outline: true, size: 56 });
arrow(`M${X.judge} ${D}V${LOW - 36}`, { dash: true });
arrow(`M${X.judge + 36} ${LOW}H${X.plan - 16}Q${X.plan} ${LOW} ${X.plan} ${LOW - 16}V${D}`, { dash: true });
// authority ↔ the person's Home
t(X.auth - 24, LOW, '#22c55e', 'home', "The person's Home", ['they sign, the run resumes'], { outline: true, size: 56 });
arrow(`M${X.auth - 24} ${D + 22}V${LOW - 36}`, { dash: true, both: true });
// receipt → vault
t(X.receipt + 34, LOW, '#6366f1', 'vault', "The agent's vault", ['the run and its provenance'], { outline: true, size: 56 });
arrow(`M${X.receipt + 34} ${D + 22}V${LOW - 36}`, { dash: true });
// execute → what a step can be
const TY = 850, G = 116, tools = [[X.exec - 1.5 * G, 'spark', 'A skill'], [X.exec - 0.5 * G, 'tool', 'An act'], [X.exec + 0.5 * G, 'plug', 'A connector'], [X.exec + 1.5 * G, 'agent', 'Another agent']];
out.push(`<path d="M${X.exec} ${D}V${TY - 62}" fill="none" stroke="${C.line}" stroke-width="2"/>`);
out.push(`<path d="M${X.exec - 1.5 * G} ${TY - 34}V${TY - 46}Q${X.exec - 1.5 * G} ${TY - 62} ${X.exec - 1.5 * G + 16} ${TY - 62}H${X.exec + 1.5 * G - 16}Q${X.exec + 1.5 * G} ${TY - 62} ${X.exec + 1.5 * G} ${TY - 46}V${TY - 34}M${X.exec - 0.5 * G} ${TY - 62}V${TY - 34}M${X.exec + 0.5 * G} ${TY - 62}V${TY - 34}" fill="none" stroke="${C.line}" stroke-width="2"/>`);
for (const [x, icon, name] of tools) {
  out.push(`<rect x="${x - 24}" y="${TY - 30}" width="48" height="48" rx="13" fill="${C.panel}" stroke="#0ea5e9" stroke-width="2"/>`);
  out.push(`<g transform="translate(${x - 12},${TY - 18})" fill="none" stroke="#0ea5e9" stroke-width="1.700" stroke-linecap="round" stroke-linejoin="round">${I[icon]}</g>`);
  out.push(`<text x="${x}" y="${TY + 40}" text-anchor="middle" class="t">${esc(name)}</text>`);
}
note(X.exec, TY + 62, ['what a step can be'], {});

// ── legend
const LX = 40, LY = 800;
out.push(`<path d="M${LX} ${LY}h44" stroke="${C.line}" stroke-width="2" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 4}" class="s" text-anchor="start">the ask</text>`);
out.push(`<path d="M${LX} ${LY + 26}h44" stroke="${C.skill}" stroke-width="2" marker-end="url(#as)"/><text x="${LX + 58}" y="${LY + 30}" class="s" text-anchor="start">a skill, on its way in</text>`);
out.push(`<path d="M${LX} ${LY + 52}h44" stroke="${C.line}" stroke-width="2" stroke-dasharray="6 6" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 56}" class="s" text-anchor="start">only when needed</text>`);
note(LX, LY + 92, ['Choosing a skill never permits anything:', 'the chosen step still meets every gate after it.'], { anchor: 'start' });
out.push(`<text x="${W - 40}" y="${H - 26}" class="s" text-anchor="end">faithnet.estate/architecture</text>`);

finish(process.argv[2],
  'How an ask runs at an agent: the agent harness, with skills flowing in',
  "An ask goes from the asker through admission, the playbook, grounding, the skill judge, planning and a plan check. Then every step is authorized by a mandate, executed and receipted, and the answer returns. Skills enter from the top: a SKILL.md is published to the skills registry, compiled with the domain ontology into an archetype, and assigned to the agent as its playbook. The judge reads each skill's card; the skill's body is read by its pinned digest when the step runs.");
