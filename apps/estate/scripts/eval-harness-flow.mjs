// Draws how the Ask evaluation harness measures an answer against what its author wrote, for /architecture/eval-harness.
//   node scripts/eval-harness-flow.mjs assets/architecture/eval-harness-flow.svg
// The PNG beside it (the link preview) is that SVG rendered at 2x in a browser.
// The numbered tiles are the steps the page lists beside the picture; their centres are repeated in src/architecture.ts (`at`).
import { C, picture } from './picture-kit.mjs';
const W = 1460, H = 960, ROW = 410, S = 64;
const { out, tile, arrow, note, finish } = picture(W, H);

out.push(`<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>`);
out.push(`<text x="40" y="52" class="h">How we measure an answer against what its author wrote</text>`);
out.push(`<text x="40" y="78" class="s" text-anchor="start">The gold is the author's own sentences, not what a model remembers. A judge only says whether each sentence was said, and code checks its quote. Links and records are counted by code.</text>`);

const X = { src: 84, pin: 216, ask: 348, gold: 480, answer: 612, judge: 756, links: 900, record: 1044, report: 1188, learn: 1380 };
const h = S / 2 + 8;
const hop = (a, b) => arrow(`M${X[a] + h} ${ROW}H${X[b] - h - 4}`);
const t = (x, y, color, icon, name, sub, o = {}) => tile(x, y, color, icon, name, sub, { size: S, ...o });
for (const [a, b] of [['src', 'pin'], ['pin', 'ask'], ['ask', 'gold'], ['gold', 'answer'], ['answer', 'judge'], ['judge', 'links'], ['links', 'record'], ['record', 'report'], ['report', 'learn']]) hop(a, b);
t(X.src, ROW, '#64748b', 'books', 'Sources', ['notes, articles,', 'early writings']);
t(X.pin, ROW, '#8b5cf6', 'seal', 'Pin', ['freeze the code'], { n: 1 });
t(X.ask, ROW, '#3b82f6', 'chat', 'Questions', ['from what a note', 'answers'], { n: 2 });
t(X.gold, ROW, '#14b8a6', 'file', 'Gold', ["author's sentences"], { n: 3 });
t(X.answer, ROW, '#f59e0b', 'pen', 'Answer', ['five answerers'], { n: 4 });
t(X.judge, ROW, '#ef4444', 'scales', 'Judge', ['each sentence said?'], { n: 5 });
t(X.links, ROW, '#0ea5e9', 'link', 'Links', ['counted by code'], { n: 6 });
t(X.record, ROW, '#a855f7', 'fork', 'Record test', ['record or memory?'], { n: 7 });
t(X.report, ROW, '#6366f1', 'receipt', 'Report', ['each number apart'], { n: 8 });
t(X.learn, ROW, '#64748b', 'spark', 'What we learn', ['what to fix next']);

// ── controls, from above: they test the judge before its verdicts are read
const TOP = 204;
out.push(`<text x="${X.judge}" y="${TOP - 50}" text-anchor="middle" class="b" style="fill:${C.skill}">CHECKS ON THE JUDGE</text>`);
t(X.judge - 90, TOP, C.skill, 'file', "Author's own text", ['must read as said'], { outline: true, size: 56 });
t(X.judge + 90, TOP, C.skill, 'tool', 'Decoy', ['must read as unsaid'], { outline: true, size: 56 });
arrow(`M${X.judge - 90} ${TOP + 86}V${ROW - 90}Q${X.judge - 90} ${ROW - 74} ${X.judge - 74} ${ROW - 74}H${X.judge - 30}Q${X.judge - 14} ${ROW - 74} ${X.judge - 14} ${ROW - 58}V${ROW - h - 4}`, { color: C.skill });
arrow(`M${X.judge + 90} ${TOP + 86}V${ROW - 90}Q${X.judge + 90} ${ROW - 74} ${X.judge + 74} ${ROW - 74}H${X.judge + 30}Q${X.judge + 14} ${ROW - 74} ${X.judge + 14} ${ROW - 58}V${ROW - h - 4}`, { color: C.skill });

// ── the answerers, from below
const LOW = 660, D = ROW + 94, G = 132, names = [['layers', 'Native record', 'before English'], ['pen', 'Our answer', 'in English'], ['agent', 'Bare model', 'no sources'], ['agent', 'Product 1', ''], ['agent', 'Product 2', 'saved answers']];
out.push(`<text x="${X.answer}" y="${LOW + 116}" text-anchor="middle" class="b">THE ANSWERERS</text>`);
out.push(`<path d="M${X.answer - 2 * G} ${LOW - 40}V${LOW - 56}Q${X.answer - 2 * G} ${LOW - 72} ${X.answer - 2 * G + 16} ${LOW - 72}H${X.answer + 2 * G - 16}Q${X.answer + 2 * G} ${LOW - 72} ${X.answer + 2 * G} ${LOW - 56}V${LOW - 40}M${X.answer - G} ${LOW - 72}V${LOW - 40}M${X.answer} ${LOW - 72}V${LOW - 40}M${X.answer + G} ${LOW - 72}V${LOW - 40}" fill="none" stroke="${C.line}" stroke-width="2"/>`);
arrow(`M${X.answer} ${LOW - 72}V${D}`);
names.forEach(([icon, name, sub], i) => t(X.answer + (i - 2) * G, LOW, '#f59e0b', icon, name, [sub], { outline: true, size: 56 }));

// ── the record test: the same question, the records changed
const RX = X.record + 40, RY = LOW;
t(RX, RY, '#a855f7', 'tool', 'Changed records', ['Saul → Ashbel'], { outline: true, size: 56 });
arrow(`M${RX} ${RY - 40}V${ROW + 120}Q${RX} ${ROW + 104} ${RX - 16} ${ROW + 104}H${X.record + 16}Q${X.record} ${ROW + 104} ${X.record} ${ROW + 88}V${D}`, { color: '#a855f7' });
note(RX + 44, RY - 10, ['the harness answers again;', 'which word does it use?'], { anchor: 'start', color: '#a855f7' });

// ── the gold comes from the sources: an arc from the published answers to the gold
const ARC = 112;
arrow(`M${X.src} ${ROW - h}V${ARC + 16}Q${X.src} ${ARC} ${X.src + 16} ${ARC}H${X.gold - 16}Q${X.gold} ${ARC} ${X.gold} ${ARC + 16}V${ROW - h - 4}`, { dash: true });
note(X.src + 12, ARC + 24, ["the author's own words,", 'exact sentences only'], { anchor: 'start' });

// ── legend
const LX = 40, LY = 790;
out.push(`<path d="M${LX} ${LY}h44" stroke="${C.line}" stroke-width="2" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 4}" class="s" text-anchor="start">questions, gold and answers</text>`);
out.push(`<path d="M${LX} ${LY + 26}h44" stroke="${C.skill}" stroke-width="2" marker-end="url(#as)"/><text x="${LX + 58}" y="${LY + 30}" class="s" text-anchor="start">a check on the judge</text>`);
out.push(`<path d="M${LX} ${LY + 52}h44" stroke="#a855f7" stroke-width="2" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 56}" class="s" text-anchor="start">the record test</text>`);
note(LX, LY + 92, ['A track whose checks fail reports no number.', 'Every number names who assessed it: code, a model, or a person.'], { anchor: 'start' });
out.push(`<text x="${W - 40}" y="${H - 26}" class="s" text-anchor="end">faithnet.estate/architecture</text>`);

finish(process.argv[2],
  'How we measure an answer against what its author wrote',
  "Published answers (study notes, commentaries, articles and writings before 1000 AD) are the source. The candidate is pinned. Questions are formed from what a note or article answers. The gold is the author's own sentences. Five answerers answer: our original-language record, our English answer, the bare model, Product 1 and Product 2. A judge says, for each author sentence, whether an answer stated it, and code checks the judge's quote; the author's own text and a decoy test the judge first. Links are counted by code. A record test changes a name or number in every record the harness reads and asks which word the answer uses. A report keeps each number apart.");
