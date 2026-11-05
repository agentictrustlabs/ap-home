// Draws the agent-harness flow picture for /architecture/agent-harness. The SVG in assets/architecture/ is this script's output:
//   node scripts/agent-harness-flow.mjs assets/architecture/agent-harness-flow.svg
// The PNG beside it (the link preview) is that SVG rendered at 2x in a browser, 3840x2080.
import { writeFileSync } from 'node:fs';
const W = 1920, H = 1040, ROW = 500, T = 76;
const C = { bg: '#0b1020', panel: '#111933', line: '#8b95b5', text: '#eef1fb', muted: '#9aa5c7', skill: '#f472b6', dash: '#3a4670' };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// icons, drawn in a 24×24 box, white strokes
const I = {
  person: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c.8-4 3.8-6 7.5-6s6.700 2 7.500 6"/>',
  door: '<path d="M10 4h8v16h-8"/><path d="M3 12h10"/><path d="M9.500 8.500 13 12l-3.500 3.500"/>',
  book: '<path d="M5 4.500h10.500a2.500 2.500 0 0 1 2.500 2.500v12.500H7.500A2.500 2.500 0 0 1 5 17z"/><path d="M5 17a2.500 2.500 0 0 1 2.500-2.500H18"/><path d="M9 8.500h5.500"/>',
  target: '<circle cx="12" cy="12" r="7.500"/><circle cx="12" cy="12" r="2.600"/><path d="M12 2.500v3M12 18.500v3M2.500 12h3M18.500 12h3"/>',
  scales: '<path d="M12 4v16M7 20h10M5 7h14"/><path d="M5 7l-2.500 6a2.700 2.700 0 0 0 5 0z"/><path d="M19 7l-2.500 6a2.700 2.700 0 0 0 5 0z"/>',
  plan: '<circle cx="5.500" cy="6" r="2"/><circle cx="5.500" cy="18" r="2"/><circle cx="18.500" cy="12" r="2"/><path d="M7.500 6h4a3 3 0 0 1 3 3v.500M7.500 18h4a3 3 0 0 0 3-3v-.500"/>',
  check: '<path d="M12 3l7.500 3v5.500c0 4.500-3.200 7.800-7.500 9.500-4.300-1.700-7.500-5-7.500-9.500V6z"/><path d="M8.500 12l2.500 2.500 4.500-5"/>',
  key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M17.500 12v3.500M20.500 12v2.500"/>',
  play: '<circle cx="12" cy="12" r="8.500"/><path d="M10 8.500v7l6-3.500z"/>',
  receipt: '<path d="M6 3.500h12v17l-2.400-1.600-2.400 1.600-2.400-1.600-2.400 1.600L6 20.500z"/><path d="M9 8.500h6M9 12h6M9 15.500h3.500"/>',
  chat: '<path d="M4 5.500h16v11H11l-4.500 3.500v-3.500H4z"/><path d="M8 9.500h8M8 12.800h5"/>',
  file: '<path d="M6.500 3.500h7l4 4v13h-11z"/><path d="M13.500 3.500v4h4"/><path d="M9 12h6M9 15.500h6"/>',
  stack: '<ellipse cx="12" cy="6.500" rx="7" ry="2.800"/><path d="M5 6.500v5.500c0 1.500 3.100 2.800 7 2.800s7-1.300 7-2.800V6.500"/><path d="M5 12v5.500c0 1.500 3.100 2.800 7 2.800s7-1.300 7-2.800V12"/>',
  graph: '<circle cx="6" cy="6" r="2.300"/><circle cx="18" cy="7" r="2.300"/><circle cx="12" cy="18" r="2.300"/><path d="M8.200 6.400l7.500.400M7.200 8l3.700 8M16.800 9l-3.700 7"/>',
  box: '<path d="M12 3.500l7.500 4v9l-7.500 4-7.500-4v-9z"/><path d="M4.500 7.500l7.500 4 7.500-4M12 11.500v9"/>',
  spark: '<path d="M12 3.500l1.900 5.600 5.600 1.900-5.600 1.900L12 18.500l-1.900-5.600L4.500 11l5.600-1.900z"/><path d="M18.500 16.500v3M17 18h3"/>',
  home: '<path d="M4 11.500 12 4.500l8 7"/><path d="M6.500 10v9.500h11V10"/><path d="M10 19.500v-5h4v5"/>',
  vault: '<rect x="4" y="4.500" width="16" height="14" rx="2"/><circle cx="12" cy="11.500" r="3"/><path d="M12 8.500v-1M7 18.500v2M17 18.500v2"/>',
  tool: '<path d="M14.500 5a4 4 0 0 0-4.800 5.200L4.500 15.400l2.600 2.600 5.200-5.200A4 4 0 0 0 17.500 8l-2.500 2.500-2-2z"/>',
  plug: '<path d="M9 3.500v4.500M15 3.500v4.500M6.500 8h11v3.500a5.500 5.500 0 0 1-11 0zM12 17v3.500"/>',
  agent: '<rect x="5" y="8" width="14" height="10.500" rx="3"/><path d="M12 8V4.500"/><circle cx="12" cy="3.800" r="1"/><circle cx="9.300" cy="13" r="1.200"/><circle cx="14.700" cy="13" r="1.200"/>',
};
const out = [];
const tile = (x, y, color, icon, name, sub = [], o = {}) => {
  const s = o.size ?? T, r = o.outline ? 16 : 18;
  out.push(`<g>`);
  out.push(o.outline
    ? `<rect x="${x - s / 2}" y="${y - s / 2}" width="${s}" height="${s}" rx="${r}" fill="${C.panel}" stroke="${color}" stroke-width="2.200"/>`
    : `<rect x="${x - s / 2}" y="${y - s / 2}" width="${s}" height="${s}" rx="${r}" fill="${color}"/>`);
  const k = (s * 0.52) / 24;
  out.push(`<g transform="translate(${x - 12 * k},${y - 12 * k}) scale(${k})" fill="none" stroke="${o.outline ? color : '#fff'}" stroke-width="${1.700}" stroke-linecap="round" stroke-linejoin="round">${I[icon]}</g>`);
  const ly = y + s / 2 + 24;
  out.push(`<text x="${x}" y="${ly}" text-anchor="middle" class="n">${esc(name)}</text>`);
  sub.forEach((t, i) => out.push(`<text x="${x}" y="${ly + 19 + i * 16}" text-anchor="middle" class="s">${esc(t)}</text>`));
  out.push(`</g>`);
};
const arrow = (d, o = {}) => out.push(`<path d="${d}" fill="none" stroke="${o.color ?? C.line}" stroke-width="${o.w ?? 2}" ${o.dash ? 'stroke-dasharray="6 6"' : ''} marker-end="url(#${o.color === C.skill ? 'as' : 'a'})"${o.both ? ` marker-start="url(#${o.color === C.skill ? 'bs' : 'b'})"` : ''}/>`);
const note = (x, y, lines, o = {}) => lines.forEach((t, i) => out.push(`<text x="${x}" y="${y + i * 16}" text-anchor="${o.anchor ?? 'middle'}" class="${o.cls ?? 's'}"${o.color ? ` style="fill:${o.color}"` : ''}>${esc(t)}</text>`));

// ── frame and titles
out.push(`<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>`);
out.push(`<text x="48" y="58" class="h">How an ask runs at an agent</text>`);
out.push(`<text x="48" y="84" class="s" text-anchor="start">The agent harness of a faithnet Home, with the skills that flow into it. Intelligence may be probabilistic. Authority must not be.</text>`);

// ── main row positions
const X = { asker: 100, admit: 250, playbook: 400, ground: 550, judge: 700, plan: 850, check: 1000, auth: 1180, exec: 1335, receipt: 1490, answer: 1670, back: 1820 };
const h = T / 2 + 8;
const hop = (a, b) => arrow(`M${X[a] + h} ${ROW}H${X[b] - h - 4}`);

// the per-step box
out.push(`<rect x="1094" y="${ROW - 92}" width="482" height="${228}" rx="20" fill="none" stroke="${C.dash}" stroke-width="2" stroke-dasharray="7 7"/>`);
out.push(`<text x="1114" y="${ROW - 66}" text-anchor="start" class="b">PER STEP, NEVER PER RUN</text>`);

for (const [a, b] of [['asker', 'admit'], ['admit', 'playbook'], ['playbook', 'ground'], ['ground', 'judge'], ['judge', 'plan'], ['plan', 'check'], ['check', 'auth'], ['auth', 'exec'], ['exec', 'receipt'], ['receipt', 'answer'], ['answer', 'back']]) hop(a, b);
tile(X.asker, ROW, '#64748b', 'person', 'Asker', ['a person, an app', 'or another agent']);
tile(X.admit, ROW, '#8b5cf6', 'door', 'Admit', ['Home session, signed', 'wire or A2A']);
tile(X.playbook, ROW, '#3b82f6', 'book', 'Playbook', ['checked against', 'its digest']);
tile(X.ground, ROW, '#14b8a6', 'target', 'Ground', ['a typed reading,', 'before any model']);
tile(X.judge, ROW, '#ef4444', 'scales', 'Judge', ['which ONE skill,', 'or none of them']);
tile(X.plan, ROW, '#f59e0b', 'plan', 'Plan', ['the pick, or with', 'what feeds it']);
tile(X.check, ROW, '#eab308', 'check', 'Check the plan', ['refuse, ask,', 'or replan once']);
tile(X.auth, ROW, '#22c55e', 'key', 'Authority', ['a signed mandate', 'allows the step']);
tile(X.exec, ROW, '#0ea5e9', 'play', 'Execute', ['reconcile first,', 'then run once']);
tile(X.receipt, ROW, '#6366f1', 'receipt', 'Receipt', ['what ran, under', 'which skill']);
tile(X.answer, ROW, '#3b82f6', 'chat', 'Answer', ['as the skill wrote it,', 'or grounded']);
tile(X.back, ROW, '#64748b', 'person', 'Asker', ['answer, prompt', 'or refusal']);

// ── skills flow in (top lane)
const TOP = 206;
out.push(`<text x="48" y="${TOP - 62}" class="b" text-anchor="start" style="fill:${C.skill}">SKILLS FLOW IN</text>`);
tile(100, TOP, C.skill, 'file', 'SKILL.md', ['written by', 'its author'], { outline: true });
tile(250, TOP, C.skill, 'stack', 'Skills registry', ['published, with', 'a commitment'], { outline: true });
tile(400, TOP, C.skill, 'box', 'Archetype', ['one tool per skill,', 'one digest'], { outline: true });
tile(550, TOP, C.skill, 'graph', 'Domain ontology', ['covers, produces,', 'consumes'], { outline: true });
arrow(`M${100 + h} ${TOP}H${250 - h - 4}`, { color: C.skill });
arrow(`M${250 + h} ${TOP}H${400 - h - 4}`, { color: C.skill });
arrow(`M${550 - h} ${TOP}H${400 + h + 4}`, { color: C.skill });
// archetype → playbook (assigned)
arrow(`M400 ${TOP + 112}V${ROW - h - 4}`, { color: C.skill });
note(414, TOP + 136, ['assigned by the agent\'s custodian,', 'pinned by digest'], { anchor: 'start', color: C.skill });
// playbook → judge: the cards (an arc just above the row)
arrow(`M${X.playbook + 26} ${ROW - h}V${ROW - 84}Q${X.playbook + 26} ${ROW - 100} ${X.playbook + 42} ${ROW - 100}H${X.judge - 16}Q${X.judge} ${ROW - 100} ${X.judge} ${ROW - 84}V${ROW - h - 4}`, { color: C.skill, dash: true });
note(X.playbook + 50, ROW - 110, ['each skill\'s card: purpose, produces, not for'], { anchor: 'start', color: C.skill });
// registry → execute: the body, by pinned digest
arrow(`M250 ${TOP - h}V124Q250 108 266 108H${X.exec - 16}Q${X.exec} 108 ${X.exec} 124V${ROW - h - 4}`, { color: C.skill, dash: true });
note(800, 132, ['the skill\'s body, read at answer time by the digest the playbook pinned. A body that moved is refused, never applied.'], { color: C.skill });

// ── below the row
const LOW = 745;
// judge → planner model → plan
tile(X.judge, LOW, '#f59e0b', 'spark', 'Planner model', ['no skill fits: plans over', 'the agent\'s other tools'], { outline: true, size: 64 });
arrow(`M${X.judge} ${ROW + 118}V${LOW - 40}`, { dash: true });
arrow(`M${X.judge + 40} ${LOW}H${X.plan - 16}Q${X.plan} ${LOW} ${X.plan} ${LOW - 16}V${ROW + 118}`, { dash: true });
// authority ↔ the person's Home
tile(X.auth - 30, LOW, '#22c55e', 'home', 'The person\'s Home', ['no mandate yet: they sign,', 'and the same run resumes'], { outline: true, size: 64 });
arrow(`M${X.auth - 30} ${ROW + 118}V${LOW - 40}`, { dash: true, both: true });
// receipt → vault
tile(X.receipt + 30, LOW, '#6366f1', 'vault', 'The agent\'s vault', ['the run record and', 'its provenance'], { outline: true, size: 64 });
arrow(`M${X.receipt + 30} ${ROW + 118}V${LOW - 40}`, { dash: true });
// execute → what a step can be
const TY = 940, tools = [[X.exec - 180, 'spark', 'A skill', ''], [X.exec - 60, 'tool', 'An act', ''], [X.exec + 60, 'plug', 'A connector', ''], [X.exec + 180, 'agent', 'Another agent', '']];
out.push(`<path d="M${X.exec} ${ROW + 118}V${TY - 62}" fill="none" stroke="${C.line}" stroke-width="2"/>`);
out.push(`<path d="M${X.exec - 180} ${TY - 34}V${TY - 46}Q${X.exec - 180} ${TY - 62} ${X.exec - 164} ${TY - 62}H${X.exec + 164}Q${X.exec + 180} ${TY - 62} ${X.exec + 180} ${TY - 46}V${TY - 34}M${X.exec - 60} ${TY - 62}V${TY - 34}M${X.exec + 60} ${TY - 62}V${TY - 34}" fill="none" stroke="${C.line}" stroke-width="2"/>`);
for (const [x, icon, name] of tools) {
  out.push(`<rect x="${x - 24}" y="${TY - 30}" width="48" height="48" rx="13" fill="${C.panel}" stroke="#0ea5e9" stroke-width="2"/>`);
  out.push(`<g transform="translate(${x - 12},${TY - 18})" fill="none" stroke="#0ea5e9" stroke-width="1.700" stroke-linecap="round" stroke-linejoin="round">${I[icon]}</g>`);
  out.push(`<text x="${x}" y="${TY + 40}" text-anchor="middle" class="t">${esc(name)}</text>`);
}
note(X.exec, TY + 62, ['what a step can be'], {});

// ── legend
const LX = 48, LY = 900;
out.push(`<path d="M${LX} ${LY}h44" stroke="${C.line}" stroke-width="2" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 4}" class="s" text-anchor="start">the ask</text>`);
out.push(`<path d="M${LX} ${LY + 26}h44" stroke="${C.skill}" stroke-width="2" marker-end="url(#as)"/><text x="${LX + 58}" y="${LY + 30}" class="s" text-anchor="start">a skill, on its way in</text>`);
out.push(`<path d="M${LX} ${LY + 52}h44" stroke="${C.line}" stroke-width="2" stroke-dasharray="6 6" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 56}" class="s" text-anchor="start">only when needed</text>`);
out.push(`<text x="${LX}" y="${LY + 92}" class="s" text-anchor="start">Choosing a skill never permits anything: the chosen step still meets every gate after it.</text>`);
out.push(`<text x="${W - 48}" y="${H - 30}" class="s" text-anchor="end">faithnet.estate/architecture</text>`);

const marker = (id, color, start) => `<marker id="${id}" viewBox="0 0 10 10" refX="${start ? 1 : 9}" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="${start ? 'M10 0 0 5l10 5z' : 'M0 0l10 5-10 5z'}" fill="${color}"/></marker>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">How an ask runs at an agent: the agent harness, with skills flowing in</title>
<desc id="d">An ask goes from the asker through admission, the playbook, grounding, the skill judge, planning and a plan check. Then every step is authorized by a mandate, executed and receipted, and the answer returns. Skills enter from the top: a SKILL.md is published to the skills registry, compiled with the domain ontology into an archetype, and assigned to the agent as its playbook, pinned by digest. The judge reads each skill's card; the skill's body is read by its pinned digest when the step runs.</desc>
<defs>${marker('a', C.line)}${marker('b', C.line, true)}${marker('as', C.skill)}${marker('bs', C.skill, true)}
<style>text{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:${C.text}}.h{font-size:30px;font-weight:700}.n{font-size:16px;font-weight:650}.t{font-size:13px;font-weight:600}.s{font-size:13px;fill:${C.muted}}.b{font-size:12px;font-weight:700;letter-spacing:.09em;fill:${C.muted}}</style></defs>
${out.join('\n')}
</svg>
`;
// the number literals above carry trailing zeros so a search-and-replace cannot merge them; strip them for a clean file
writeFileSync(process.argv[2], svg.replace(/(\d)\.(\d*?)0+(?=[^\d])/g, (m, a, b) => (b ? `${a}.${b}` : a)));
console.log('wrote', process.argv[2], svg.length);
