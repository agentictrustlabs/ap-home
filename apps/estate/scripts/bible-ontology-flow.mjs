// Draws how the Bible's ontology is made, stored and used: canonical ids and stories at build time, one graph and the skills registry, the live Ask
// harness that reads them, and the harness ideas that would lean on them harder (proposed, not built).
//   node scripts/bible-ontology-flow.mjs assets/architecture/bible-ontology-flow.svg
// The PNG beside it (the link preview) is that SVG rendered at 2x in a browser. The numbered tiles are the steps the page lists; their centres are repeated in src/architecture.ts (`at`).
import { C, picture } from './picture-kit.mjs';
const W = 1460, H = 1190, S = 66, GREY = '#64748b', AMBER = '#f59e0b', TEAL = '#14b8a6', BLUE = '#3b82f6', VIOLET = '#8b5cf6', GREEN = '#22c55e';
const { out, tile, arrow, note, head, finish } = picture(W, H);
head(TEAL); head(VIOLET); head(AMBER);   // registered in this order: m0, m1, m2
const t = (x, y, color, icon, name, sub, o = {}) => tile(x, y, color, icon, name, sub, { size: S, ...o });
const band = (y, h, color, label, sub, o = {}) => {
  out.push(`<rect x="24" y="${y}" width="${W - 48}" height="${h}" rx="20" fill="${color}" fill-opacity="${o.dash ? 0.05 : 0.07}" stroke="${color}" stroke-opacity="${o.dash ? 0.9 : 0.35}" stroke-width="${o.dash ? 2 : 1.500}"${o.dash ? ' stroke-dasharray="9 7"' : ''}/>`);
  out.push(`<text x="46" y="${y + 30}" class="b" text-anchor="start" style="fill:${color}">${label}</text>`);
  out.push(`<text x="${W - 46}" y="${o.low ? y + h - 16 : y + 30}" class="s" text-anchor="end">${sub}</text>`);
};
out.push(`<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>`);
out.push(`<text x="40" y="52" class="h">From Hebrew and Greek to an answer: how the Bible's ontology is made and used</text>`);
out.push(`<text x="40" y="78" class="s" text-anchor="start">Canonical ids hold it together. A model proposes, code checks, and every record says how sure it is. The harness reads it through skills.</text>`);

// ── 1 make
const Y1 = 196;
band(100, 322, TEAL, '1 · MAKE IT, BEFORE ANYONE ASKS', 'built from committed sources, by code and small models');
const X1 = [130, 370, 610, 850, 1090, 1330];
for (let i = 0; i < 5; i++) arrow(`M${X1[i] + 45} ${Y1}H${X1[i + 1] - 49}`);
t(X1[0], Y1, TEAL, 'book', 'Source words', ['Hebrew, Aramaic, Greek', '1,189 chapters, tagged'], { n: 1 });
t(X1[1], Y1, BLUE, 'id', 'Canonical ids', ['3,129 people, 5,221 terms', '5,535 name forms'], { n: 2 });
t(X1[2], Y1, VIOLET, 'layers', "The Bible's story", ['6,857 scenes', '30,965 verse states'], { n: 3 });
t(X1[3], Y1, '#ec4899', 'chat', 'Who said what', ['8,404 acts of speech', 'situation kinds'], { n: 4 });
t(X1[4], Y1, '#f97316', 'books', 'Writings and retellings', ['154 story files', '405 shared episodes'], { n: 5 });
t(X1[5], Y1, GREEN, 'seal', 'Readings of a verse', ['each with its quote', 'and a check on it'], { n: 6 });
// the thread of ids
const RIB = 330;
out.push(`<rect x="52" y="${RIB}" width="${W - 104}" height="70" rx="14" fill="${C.panel}" stroke="${C.dash}"/>`);
out.push(`<text x="72" y="${RIB + 28}" class="b" text-anchor="start" style="fill:${BLUE}">ONE THREAD OF IDS</text>`);
out.push(`<text x="72" y="${RIB + 50}" class="s" text-anchor="start">Layers join on ids, never on names.</text>`);
const chips = [['verse', 'Gen.22.2'], ['person', 'skb:person-Isaac_Gen.17.19-Jas'], ['term', "Strong's H7965"], ['situation', 'scr:Battle'], ['writing', '1 Clement 16']];
let cx = 348;
for (const [k, v] of chips) { const w = 26 + v.length * 7.4; out.push(`<rect x="${cx}" y="${RIB + 13}" width="${w}" height="44" rx="10" fill="${C.bg}" stroke="${BLUE}" stroke-opacity="0.65"/><text x="${cx + w / 2}" y="${RIB + 30}" text-anchor="middle" class="s" style="font-size:11px">${k}</text><text x="${cx + w / 2}" y="${RIB + 47}" text-anchor="middle" class="n" style="font-size:13px">${v}</text>`); cx += w + 12; }

// ── 2 store
const Y2 = 512, DOT = Y2 + 96;
band(438, 190, BLUE, '2 · STORE IT', 'nothing here is written at ask time');
const G = 430, KB = 650, D1 = 860, SK = 1120, RG = 1330;
t(G, Y2, BLUE, 'graph', 'One graph, two doors', ['22 million facts', 'plus fast tables'], { n: 7 });
t(KB, Y2, BLUE, 'stack', 'scripture-kb', ['GraphDB: any shape,', 'by SPARQL'], { outline: true, size: 56 });
t(D1, Y2, BLUE, 'box', 'D1 tables', ['names, kin, notes,', 'projected at build'], { outline: true, size: 56 });
t(SK, Y2, C.skill, 'file', 'Skill artifacts', ['43 owned, versioned', 'SKILL.md files'], { n: 8 });
t(RG, Y2, C.skill, 'stack', 'Skills registry', ['owner, version,', 'content commitment'], { outline: true, size: 56 });
arrow(`M${G + 45} ${Y2}H${KB - 40}`); arrow(`M${KB + 32} ${Y2}H${D1 - 36}`, { dash: true });
arrow(`M${SK + 45} ${Y2}H${RG - 40}`, { color: C.skill });
arrow(`M${G} ${RIB + 70}V${Y2 - 46}`);

// ── 3 use
const Y3 = 750, ROW = [100, 340, 610, 880, 1120, 1360];
band(672, 204, GREEN, '3 · USE IT: LIVE ASK', 'the ontology gathers and checks; a model writes; code proves the verses', { low: true });
t(ROW[0], Y3, GREY, 'person', 'Reader', ['asks a question']);
t(ROW[1], Y3, '#ef4444', 'scales', 'Judge the question', ['intent names a scope', 'and what to gather'], { n: 9 });
t(ROW[2], Y3, TEAL, 'search', 'Gather by id', ['a name binds, or none', 'notes, original words'], { n: 10 });
t(ROW[3], Y3, VIOLET, 'graph', 'Graph research', ['readings of a passage only:', 'model writes a query'], { n: 11 });
t(ROW[4], Y3, GREEN, 'pen', 'Write and prove', ['every verse checked', 'receipt names sources'], { n: 12 });
t(ROW[5], Y3, GREY, 'person', 'Reader', ['answer and links']);
for (let i = 0; i < 5; i++) arrow(`M${ROW[i] + 45} ${Y3}H${ROW[i + 1] - 49}`);
const dot = (x, c) => out.push(`<circle cx="${x}" cy="${DOT}" r="4" fill="${c}"/>`);
dot(D1, TEAL); dot(KB, VIOLET); dot(SK, C.skill); dot(G, AMBER);
out.push(`<path d="M${D1} ${DOT}V${DOT + 44}H${ROW[2]}V${Y3 - 46}" fill="none" stroke="${TEAL}" stroke-width="2.200" marker-end="url(#m0)"/>`);
out.push(`<path d="M${KB} ${DOT}V${DOT + 30}H${ROW[3]}V${Y3 - 46}" fill="none" stroke="${VIOLET}" stroke-width="2.200" marker-end="url(#m1)"/>`);
out.push(`<path d="M${SK} ${DOT}V${DOT + 16}H${ROW[1]}V${Y3 - 46}" fill="none" stroke="${C.skill}" stroke-width="2" marker-end="url(#as)"/>`);
arrow(`M${SK} ${DOT}V${Y3 - 46}`, { color: C.skill });
note(ROW[1] + 14, Y3 - 48, ['intent and scope cards'], { anchor: 'start', color: C.skill });
note(SK + 14, Y3 - 48, ['form: shape of the answer'], { anchor: 'start', color: C.skill });

// ── 4 ideas
const Y4 = 984, XI = [215, 560, 905, 1250];
band(892, 278, AMBER, '4 · HARNESS IDEAS', 'how each new idea uses the ontology, and how far it has got', { dash: true });
const pill = (x, y, label, color) => { const w = 18 + label.length * 6.6; out.push(`<rect x="${x - w / 2}" y="${y}" width="${w}" height="24" rx="12" fill="${color}" fill-opacity="0.16" stroke="${color}"/><text x="${x}" y="${y + 16}" text-anchor="middle" class="s" style="fill:${color};font-size:12px">${label}</text>`); };
t(XI[0], Y4, AMBER, 'search', 'ASTER', ['resolve, explore, write', 'a query, repair it'], { n: 13, outline: true });
t(XI[1], Y4, AMBER, 'file', 'SPARQL-LLM', ['graph metadata and real', 'examples; check the query'], { n: 14, outline: true });
t(XI[2], Y4, AMBER, 'target', 'GTA-RAG', ['graph paths become', 'research exercises'], { n: 15, outline: true });
t(XI[3], Y4, AMBER, 'check', 'Decide and refuse', ['ontology decides, model', 'writes, code refuses'], { n: 16, outline: true });
const PY = Y4 + 100;
pill(XI[0], PY, 'pattern live in step 11', GREEN);
pill(XI[1], PY, 'validator logs only; gain not shown', AMBER);
pill(XI[2], PY, 'exercises live; training not built', AMBER);
pill(XI[3], PY, 'tested on altered verses only', AMBER);
// what they read, and what comes back
out.push(`<path d="M${G} ${DOT}V${DOT + 30}H220Q215 ${DOT + 30} 215 ${DOT + 35}V${Y4 - 46}" fill="none" stroke="${AMBER}" stroke-width="2" stroke-dasharray="6 6" marker-end="url(#m2)"/>`);
arrow(`M${XI[0] + 46} ${Y4}H${XI[1] - 50}`, { color: AMBER, dash: true, both: true });
note((XI[0] + XI[1]) / 2, Y4 - 10, ['both improve step 11'], { color: AMBER });
arrow(`M${XI[2] - 50} ${Y4}H${XI[1] + 46}`, { color: AMBER, dash: true });
note((XI[1] + XI[2]) / 2, Y4 - 10, ['the score finds the misses'], { color: AMBER });
note(730, PY + 56, ['Exercises scored by code: 25% without graph research, 86 to 93% with it. 100 questions written for these layers, judged blind: 12 better, 15 worse, 73 the same.'], { color: AMBER });
finish(process.argv[2], "How the Bible's ontology is made, stored and used", 'A four-band architecture picture: how canonical ids, stories, situations and readings are built; the graph and skills registry that store them; the live Ask harness that reads them; and the harness ideas ASTER, SPARQL-LLM, GTA-RAG and decide-and-refuse, each with how far it has got.');
