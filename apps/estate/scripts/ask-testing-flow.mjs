// Draws how the Scripture Agent's answers are tested, for /architecture/testing-answers. The SVG in assets/architecture/ is this script's output:
//   node scripts/ask-testing-flow.mjs assets/architecture/ask-testing-flow.svg
// The PNG beside it (the link preview) is that SVG rendered at 2x in a browser.
// The numbered tiles are the steps the page lists beside the picture; their centres are repeated in src/architecture.ts (`at`).
import { C, picture } from './picture-kit.mjs';
const W = 1460, H = 930, ROW = 400, S = 64;
const { out, tile, arrow, note, finish } = picture(W, H);

out.push(`<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>`);
out.push(`<text x="40" y="52" class="h">How we test the Scripture Agent's answers</text>`);
out.push(`<text x="40" y="78" class="s" text-anchor="start">Blind, in both orders, under one neutral standard. A judge's claim of an error counts only once it is confirmed. A 300-question run has finished.</text>`);

const X = { lib: 72, draw: 188, aside: 304, key: 420, answer: 536, judge: 672, confirm: 788, score: 904, remember: 1030, card: 1146, learn: 1378 };
const h = S / 2 + 8;
const hop = (a, b) => arrow(`M${X[a] + h} ${ROW}H${X[b] - h - 4}`);
const t = (x, y, color, icon, name, sub, o = {}) => tile(x, y, color, icon, name, sub, { size: S, ...o });
for (const [a, b] of [['lib', 'draw'], ['draw', 'aside'], ['aside', 'key'], ['key', 'answer'], ['answer', 'judge'], ['judge', 'confirm'], ['confirm', 'score'], ['score', 'remember'], ['remember', 'card'], ['card', 'learn']]) hop(a, b);
t(X.lib, ROW, '#64748b', 'books', 'The library', ['its articles']);
t(X.draw, ROW, '#8b5cf6', 'search', 'Draw', ['every category'], { n: 1 });
t(X.aside, ROW, '#3b82f6', 'funnel', 'Set aside', ['denominational'], { n: 2 });
t(X.key, ROW, '#14b8a6', 'file', 'Key', ['from the article'], { n: 3 });
t(X.answer, ROW, '#f59e0b', 'pen', 'Answer', ['today and skills'], { n: 4 });
t(X.judge, ROW, '#ef4444', 'scales', 'Answering', ['did it answer?'], { n: 5 });
t(X.confirm, ROW, '#22c55e', 'check', 'Accuracy', ['errors, confirmed'], { n: 6 });
t(X.score, ROW, '#0ea5e9', 'target', 'Links', ['verses and writings'], { n: 7 });
t(X.remember, ROW, '#a855f7', 'vault', 'Remember', ['real errors'], { n: 8 });
t(X.card, ROW, '#6366f1', 'receipt', 'Scorecard', ['per skill'], { n: 9 });
t(X.learn, ROW, '#64748b', 'spark', 'What we learn', ['what to change next']);

// ── controls, from above: they test the judge
const TOP = 204;
out.push(`<text x="${X.judge}" y="${TOP - 50}" text-anchor="middle" class="b" style="fill:${C.skill}">CHECKS ON THE JUDGE</text>`);
t(X.judge - 90, TOP, C.skill, 'tool', 'Planted errors', ['does it notice?'], { outline: true, size: 56 });
t(X.judge + 90, TOP, C.skill, 'loop', 'Noise control', ['the same path twice'], { outline: true, size: 56 });
arrow(`M${X.judge - 90} ${TOP + 86}V${ROW - 90}Q${X.judge - 90} ${ROW - 74} ${X.judge - 74} ${ROW - 74}H${X.judge - 30}Q${X.judge - 14} ${ROW - 74} ${X.judge - 14} ${ROW - 58}V${ROW - h - 4}`, { color: C.skill });
arrow(`M${X.judge + 90} ${TOP + 86}V${ROW - 90}Q${X.judge + 90} ${ROW - 74} ${X.judge + 74} ${ROW - 74}H${X.judge + 30}Q${X.judge + 14} ${ROW - 74} ${X.judge + 14} ${ROW - 58}V${ROW - h - 4}`, { color: C.skill });

// ── the contestants, from below
const LOW = 640, D = ROW + 94, G = 118, names = [['pen', "Today's path"], ['target', 'With skills'], ['file', 'The article'], ['agent', 'Product 1'], ['agent', 'Product 2']];
out.push(`<text x="${X.judge}" y="${LOW + 112}" text-anchor="middle" class="b">THE CONTESTANTS</text>`);
out.push(`<path d="M${X.judge - 2 * G} ${LOW - 40}V${LOW - 56}Q${X.judge - 2 * G} ${LOW - 72} ${X.judge - 2 * G + 16} ${LOW - 72}H${X.judge + 2 * G - 16}Q${X.judge + 2 * G} ${LOW - 72} ${X.judge + 2 * G} ${LOW - 56}V${LOW - 40}M${X.judge - G} ${LOW - 72}V${LOW - 40}M${X.judge} ${LOW - 72}V${LOW - 40}M${X.judge + G} ${LOW - 72}V${LOW - 40}" fill="none" stroke="${C.line}" stroke-width="2"/>`);
arrow(`M${X.judge} ${LOW - 72}V${D}`);
names.forEach(([icon, name], i) => t(X.judge + (i - 2) * G, LOW, '#f59e0b', icon, name, [''], { outline: true, size: 56 }));

// ── what goes where
const AX = X.aside;
t(AX, LOW, '#3b82f6', 'box', 'Reserved', ['for a later test'], { outline: true, size: 56 });
arrow(`M${AX} ${D}V${LOW - 40}`, { dash: true });
// the errata feed the next key
const ARC = 112;
arrow(`M${X.remember} ${ROW - h}V${ARC + 16}Q${X.remember} ${ARC} ${X.remember - 16} ${ARC}H${X.key + 16}Q${X.key} ${ARC} ${X.key} ${ARC + 16}V${ROW - h - 4}`, { color: '#a855f7', dash: true });
note(X.key + 12, ARC + 24, ['a real error in an article', 'leaves the key'], { anchor: 'start', color: '#a855f7' });
note(X.remember + 12, ARC + 24, ['a real error of ours', 'becomes a regression test'], { anchor: 'start', color: '#a855f7' });

// ── legend
const LX = 40, LY = 752;
out.push(`<path d="M${LX} ${LY}h44" stroke="${C.line}" stroke-width="2" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 4}" class="s" text-anchor="start">the questions and answers</text>`);
out.push(`<path d="M${LX} ${LY + 26}h44" stroke="${C.skill}" stroke-width="2" marker-end="url(#as)"/><text x="${LX + 58}" y="${LY + 30}" class="s" text-anchor="start">a check on the judge</text>`);
out.push(`<path d="M${LX} ${LY + 52}h44" stroke="${C.line}" stroke-width="2" stroke-dasharray="6 6" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 56}" class="s" text-anchor="start">only when needed</text>`);
note(LX, LY + 92, ['Clear wins and marginal wins are counted apart.', 'A marginal win is not reported as a win.'], { anchor: 'start' });
out.push(`<text x="${W - 40}" y="${H - 26}" class="s" text-anchor="end">faithnet.estate/architecture</text>`);

finish(process.argv[2],
  "How we test the Scripture Agent's answers",
  "Questions are drawn from a large library of articles across every category. Clearly denominational questions are set aside for a later test. A key is built from each article. Today's path and the path with skills answer. A judge compares them blind, in both orders, on one question only: did it answer what was asked. The article and two other products are contestants; planted errors and a noise control test the judge. Accuracy is checked separately, against the article and the verses, and a second model family confirms claimed errors. The verses and writings each answer links to are graded on their own. Real errors are remembered, and a scorecard per skill says what to change next.");
