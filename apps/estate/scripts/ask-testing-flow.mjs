// Draws how the Scripture Agent's answers are tested, for /architecture/testing-answers. The SVG in assets/architecture/ is this script's output:
//   node scripts/ask-testing-flow.mjs assets/architecture/ask-testing-flow.svg
// The PNG beside it (the link preview) is that SVG rendered at 2x in a browser.
// The numbered tiles are the steps the page lists beside the picture; their centres are repeated in src/architecture.ts (`at`).
import { C, picture } from './picture-kit.mjs';
const W = 1460, H = 930, ROW = 400, S = 64;
const { out, tile, arrow, note, finish } = picture(W, H);

out.push(`<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>`);
out.push(`<text x="40" y="52" class="h">How we test the Scripture Agent's answers</text>`);
out.push(`<text x="40" y="78" class="s" text-anchor="start">Blind, in both orders, under one neutral standard. Answering, accuracy and links are measured apart. A 300-question run has finished.</text>`);

const X = { lib: 72, draw: 188, aside: 304, key: 420, answer: 536, judge: 672, confirm: 788, score: 904, remember: 1030, card: 1146, learn: 1378 };
const h = S / 2 + 8;
const hop = (a, b) => arrow(`M${X[a] + h} ${ROW}H${X[b] - h - 4}`);
const t = (x, y, color, icon, name, sub, o = {}) => tile(x, y, color, icon, name, sub, { size: S, ...o });
for (const [a, b] of [['lib', 'draw'], ['draw', 'aside'], ['aside', 'key'], ['key', 'answer'], ['answer', 'judge'], ['judge', 'confirm'], ['confirm', 'score'], ['score', 'remember'], ['remember', 'card'], ['card', 'learn']]) hop(a, b);
t(X.lib, ROW, '#64748b', 'books', 'The library', ['its articles']);
t(X.draw, ROW, '#8b5cf6', 'search', 'Draw', ['every category'], { n: 1 });
t(X.aside, ROW, '#3b82f6', 'funnel', 'Set aside', ['denominational'], { n: 2 });
t(X.key, ROW, '#14b8a6', 'file', 'Key', ['from the article'], { n: 3 });
t(X.answer, ROW, '#f59e0b', 'pen', 'Answer', ['each design'], { n: 4 });
t(X.judge, ROW, '#ef4444', 'scales', 'Answering', ['did it answer?'], { n: 5 });
t(X.confirm, ROW, '#22c55e', 'check', 'Accuracy', ['each alone'], { n: 6 });
t(X.score, ROW, '#0ea5e9', 'target', 'Links', ['every link'], { n: 7 });
t(X.remember, ROW, '#a855f7', 'vault', 'Log', ['real errors'], { n: 8 });
t(X.card, ROW, '#6366f1', 'receipt', 'Scorecard', ['what each did'], { n: 9 });
t(X.learn, ROW, '#64748b', 'spark', 'What we learn', ['what to change next']);

// ── controls, from above: they test the judge
const TOP = 204;
out.push(`<text x="${X.judge}" y="${TOP - 50}" text-anchor="middle" class="b" style="fill:${C.skill}">CHECKS ON THE CHECKS</text>`);
t(X.judge - 90, TOP, C.skill, 'tool', 'Planted errors', ['does it notice?'], { outline: true, size: 56 });
t(X.judge + 90, TOP, C.skill, 'loop', 'Noise control', ['the same path twice'], { outline: true, size: 56 });
arrow(`M${X.judge - 90} ${TOP + 86}V${ROW - 90}Q${X.judge - 90} ${ROW - 74} ${X.judge - 74} ${ROW - 74}H${X.judge - 30}Q${X.judge - 14} ${ROW - 74} ${X.judge - 14} ${ROW - 58}V${ROW - h - 4}`, { color: C.skill });
arrow(`M${X.judge + 90} ${TOP + 86}V${ROW - 90}Q${X.judge + 90} ${ROW - 74} ${X.judge + 74} ${ROW - 74}H${X.judge + 30}Q${X.judge + 14} ${ROW - 74} ${X.judge + 14} ${ROW - 58}V${ROW - h - 4}`, { color: C.skill });

// ── the contestants, from below
const LOW = 640, D = ROW + 94, G = 126, names = [['pen', 'Previous path'], ['target', 'New design'], ['file', 'The article'], ['agent', 'Product 1'], ['agent', 'Product 2']];
out.push(`<text x="${X.judge}" y="${LOW + 112}" text-anchor="middle" class="b">THE CONTESTANTS</text>`);
out.push(`<path d="M${X.judge - 2 * G} ${LOW - 40}V${LOW - 56}Q${X.judge - 2 * G} ${LOW - 72} ${X.judge - 2 * G + 16} ${LOW - 72}H${X.judge + 2 * G - 16}Q${X.judge + 2 * G} ${LOW - 72} ${X.judge + 2 * G} ${LOW - 56}V${LOW - 40}M${X.judge - G} ${LOW - 72}V${LOW - 40}M${X.judge} ${LOW - 72}V${LOW - 40}M${X.judge + G} ${LOW - 72}V${LOW - 40}" fill="none" stroke="${C.line}" stroke-width="2"/>`);
arrow(`M${X.judge} ${LOW - 72}V${D}`);
names.forEach(([icon, name], i) => t(X.judge + (i - 2) * G, LOW, '#f59e0b', icon, name, [''], { outline: true, size: 56 }));

// ── what goes where
const AX = X.aside;
t(AX, LOW, '#3b82f6', 'box', 'Reserved', ['for a later test'], { outline: true, size: 56 });
arrow(`M${AX} ${D}V${LOW - 40}`, { dash: true });
// ── legend
const LX = 40, LY = 752;
out.push(`<path d="M${LX} ${LY}h44" stroke="${C.line}" stroke-width="2" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 4}" class="s" text-anchor="start">the questions and answers</text>`);
out.push(`<path d="M${LX} ${LY + 26}h44" stroke="${C.skill}" stroke-width="2" marker-end="url(#as)"/><text x="${LX + 58}" y="${LY + 30}" class="s" text-anchor="start">a check on the checks</text>`);
out.push(`<path d="M${LX} ${LY + 52}h44" stroke="${C.line}" stroke-width="2" stroke-dasharray="6 6" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 56}" class="s" text-anchor="start">only when needed</text>`);
note(LX, LY + 92, ['Clear wins and marginal wins are counted apart.', 'A marginal win is not reported as a win.'], { anchor: 'start' });
out.push(`<text x="${W - 40}" y="${H - 26}" class="s" text-anchor="end">faithnet.estate/architecture</text>`);

finish(process.argv[2],
  "How we test the Scripture Agent's answers",
  "Questions are drawn from a large library of articles across every category. Clearly denominational questions are set aside for a later test. A key is built from each article. Each design answers every question. Three checks run apart. Answering: a judge compares two answers blind, in both orders, on one question only, did it answer what was asked, with the article and two other products as contestants. Accuracy: each answer alone, against the article and the verses it cites. Links: a grade for every verse and writing. Planted errors and a noise control test the checks. Confirmed errors are logged, and a scorecard says what to change next.");
