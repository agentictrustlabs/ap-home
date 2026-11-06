// Draws the category and skill strategy for /architecture/translation-skills. The SVG in assets/architecture/ is this script's output:
//   node scripts/translation-skills-flow.mjs assets/architecture/translation-skills-flow.svg
// The PNG beside it (the link preview) is that SVG rendered at 2x in a browser.
// The numbered tiles are the steps the page lists beside the picture; their centres are repeated in src/architecture.ts (`at`).
import { C, picture } from './picture-kit.mjs';
const W = 1460, H = 1150, TOP = 220, ROW = 480, S = 64;
const { out, esc, tile, arrow, note, finish } = picture(W, H);
const ST = { same: '#64748b', built: '#3b82f6', works: '#22c55e', next: '#f59e0b' };

out.push(`<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>`);
out.push(`<text x="40" y="52" class="h">How a passage's category chooses its translation skill</text>`);
out.push(`<text x="40" y="78" class="s" text-anchor="start">A genealogy, a law, a poem and an argument fail in different ways. The category of a passage chooses a skill, and the skill sets five steps of the run.</text>`);

const X = { src: 110, cat: 330, stored: 550, select: 770, skill: 990, draft: 330, align: 550, check: 770, revise: 990, keep: 1210, record: 1390 };
const h = S / 2 + 8;
const t = (x, y, color, icon, name, sub, o = {}) => tile(x, y, color, icon, name, sub, { size: S, ...o });

// ── once, on the source
out.push(`<text x="40" y="${TOP - 100}" class="b" text-anchor="start" style="fill:${C.skill}">ONCE, ON THE SOURCE: THE SAME FOR EVERY LANGUAGE</text>`);
for (const [a, b] of [['src', 'cat'], ['cat', 'stored'], ['stored', 'select'], ['select', 'skill']]) arrow(`M${X[a] + h} ${TOP}H${X[b] - h - 4}`);
t(X.src, TOP, '#64748b', 'book', 'A passage', ['Hebrew, Aramaic', 'or Greek'], { outline: true });
t(X.cat, TOP, '#8b5cf6', 'search', 'Categorise', ['a model reads it whole'], { n: 1 });
t(X.stored, TOP, C.skill, 'graph', 'Its category', ['one of 12 families,', 'kept as data'], { outline: true });
t(X.select, TOP, '#14b8a6', 'fork', 'Select', ['by code, or hold'], { n: 2 });
t(X.skill, TOP, C.skill, 'file', 'The skill', ['its definition', 'and its settings'], { outline: true });
t(1250, TOP, '#64748b', 'books', 'Outside evidence', ['study notes, headings:', 'for step 1 only'], { outline: true, size: 56 });
arrow(`M1250 ${TOP - 40}V${TOP - 54}Q1250 ${TOP - 70} 1234 ${TOP - 70}H${X.cat + 16}Q${X.cat} ${TOP - 70} ${X.cat} ${TOP - 58}V${TOP - h - 4}`, { dash: true });
note(790, TOP - 80, ['never shown to the drafter']);

// ── the skill reaches five steps
const BUS = 382;
out.push(`<path d="M${X.skill + h} ${TOP}H1100Q1116 ${TOP} 1116 ${TOP + 16}V${BUS - 16}Q1116 ${BUS} 1100 ${BUS}H${X.draft}" fill="none" stroke="${C.skill}" stroke-width="2"/>`);
out.push(`<path d="M1116 ${BUS}H${X.keep}" fill="none" stroke="${C.skill}" stroke-width="2"/>`);
for (const k of ['draft', 'align', 'check', 'revise', 'keep']) arrow(`M${X[k]} ${BUS}V${ROW - h - 4}`, { color: C.skill });
out.push(`<text x="40" y="${BUS + 4}" class="b" text-anchor="start">ONE PASSAGE</text>`);
note(1132, BUS - 14, ['the skill sets these five steps'], { anchor: 'start', color: C.skill });

for (const [a, b] of [['draft', 'align'], ['align', 'check'], ['revise', 'keep'], ['keep', 'record']]) arrow(`M${X[a] + h} ${ROW}H${X[b] - h - 4}`);
arrow(`M${X.check + h} ${ROW}H${X.revise - h - 4}`, { dash: true });
arrow(`M110 ${ROW}H${X.draft - h - 4}`);
note(150, ROW - 30, ['the source, read as today'], { anchor: 'middle' });
t(X.draft, ROW, '#f59e0b', 'pen', 'Draft', ['what the drafter is told'], { n: 3 });
t(X.align, ROW, '#eab308', 'link', 'Align', ['what must be accounted for'], { n: 4 });
t(X.check, ROW, '#22c55e', 'check', 'Check', ['checks only this kind runs'], { n: 5 });
t(X.revise, ROW, '#0ea5e9', 'loop', 'Revise', ['what sends it back, how often'], { n: 6 });
t(X.keep, ROW, '#ef4444', 'scales', 'Keep', ['how the best pass is chosen'], { n: 7 });
t(X.record, ROW, '#a855f7', 'receipt', 'Record', ['the skill, and why'], { n: 8 });

// ── the grid: what each skill changes at each step
const GY = 596, RH = 84, CW = 208, CH = 68;
const COLS = ['draft', 'align', 'check', 'revise', 'keep'];
const ROWS = [
  ['General', 'all other kinds, or a hold', [
    ['same', 'The brief and base skill', 'nothing added'],
    ['same', 'Every content word', 'has an English owner'],
    ['same', 'The general checks', 'on every verse'],
    ['same', 'Up to two rounds', 'told what failed'],
    ['same', 'Fewest failing checks', 'the first draft wins a tie'],
  ]],
  ['Records', 'genealogies and lists', [
    ['built', 'Names, relations, counts', 'no harmonizing of lists'],
    ['built', 'Each name and number', 'to its own source word'],
    ['works', 'Relation direction', 'caught 33 of 37 planted'],
    ['built', 'Two rounds', 'a turned relation goes back'],
    ['built', 'The relation check', 'counts in the choice'],
  ]],
  ['Law', 'law and procedure', [
    ['built', 'Conditions, parties,', 'consequences, order'],
    ['next', 'Each "if" and "unless"', 'to its English'],
    ['works', 'Legal condition', 'caught 26 of 27 planted'],
    ['built', 'Two rounds', 'a lost condition goes back'],
    ['built', 'The condition check', 'counts in the choice'],
  ]],
  ['Poetry', 'songs, prayers', [
    ['built', 'Lines, images,', 'movement left unresolved'],
    ['next', 'Line by line', 'no second line folded away'],
    ['next', 'No check of its own yet', 'a line check is proposed'],
    ['built', 'One round only', 'revision flattens lines'],
    ['same', 'As the general plan', ''],
  ]],
  ['Argument', 'reasoning, exhortation', [
    ['built', 'Connectors, dependence,', 'whose voice it is'],
    ['next', 'Each connector', 'to its English'],
    ['built', 'Connector and', 'question checks'],
    ['built', 'Two rounds', 'those checks send it back'],
    ['built', 'Those checks', 'count in the choice'],
  ]],
];
ROWS.forEach(([name, kinds, cells], r) => {
  const y = GY + r * RH;
  out.push(`<text x="40" y="${y + 30}" class="n" text-anchor="start">${esc(name)}</text>`);
  out.push(`<text x="40" y="${y + 50}" class="s" text-anchor="start">${esc(kinds)}</text>`);
  cells.forEach(([st, a, b], c) => {
    const x = X[COLS[c]];
    out.push(`<rect x="${x - CW / 2}" y="${y}" width="${CW}" height="${CH}" rx="12" fill="${C.panel}" stroke="${ST[st]}" stroke-width="${st === 'same' ? 1.2 : 2}"/>`);
    out.push(`<text x="${x}" y="${y + (b ? 29 : 39)}" text-anchor="middle" class="t">${esc(a)}</text>`);
    if (b) out.push(`<text x="${x}" y="${y + 48}" text-anchor="middle" class="s">${esc(b)}</text>`);
  });
});
out.push(`<text x="40" y="${GY - 18}" class="b" text-anchor="start">WHAT EACH SKILL CHANGES</text>`);

// ── legend
const LY = GY + ROWS.length * RH + 30;
[['same', 'as today, for every passage'], ['works', 'built, and measured to catch planted errors'], ['built', 'built and tested: no gain shown yet, so it is off'], ['next', 'proposed, not built']].forEach(([st, label], i) => {
  const x = 40 + [0, 250, 590, 960][i];
  out.push(`<rect x="${x}" y="${LY - 11}" width="22" height="14" rx="4" fill="${C.panel}" stroke="${ST[st]}" stroke-width="2"/><text x="${x + 32}" y="${LY + 1}" class="s" text-anchor="start">${esc(label)}</text>`);
});
note(40, LY + 38, ['A wrong category must cost little: a skill adds care for one kind of text and takes away nothing the general plan requires. A hold changes nothing.'], { anchor: 'start' });
out.push(`<text x="${W - 40}" y="${H - 26}" class="s" text-anchor="end">faithnet.estate/architecture</text>`);

finish(process.argv[2],
  "How a passage's category chooses its translation skill",
  'Once, on the source, a model reads a passage whole and names its category, one of twelve families; outside evidence such as study notes reaches this step only. Code selects a skill from the category or holds at the general plan. The skill sets five steps of the run for one passage: what the drafter is told, what the alignment must account for, which checks run, what sends a draft back and how often, and how the best pass is chosen. The run records the skill and why. A grid shows what the general plan and the records, law, poetry and argument skills each change at those five steps, and whether each is as today, measured to work, built but off, or proposed.');
