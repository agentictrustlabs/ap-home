// Draws the Scripture Agent's ask flow as it runs: the judge records first, the verses are chosen before the writer, the writings come after the answer.
//   node scripts/scripture-intent-flow.mjs assets/architecture/scripture-intent-flow.svg
// The PNG beside it (the link preview) is that SVG rendered at 2x in a browser. The path it replaced is scripture-ask-flow, kept for the record.
// The numbered tiles are the steps the page lists beside the picture; their centres are repeated in src/architecture.ts (`at`).
import { C, picture } from './picture-kit.mjs';
const W = 1460, H = 960, ROW = 470, S = 64, GREY = '#64748b';
const { out, tile, arrow, note, finish } = picture(W, H);

out.push(`<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>`);
out.push(`<text x="40" y="52" class="h">How the Scripture Agent answers</text>`);
out.push(`<text x="40" y="78" class="s" text-anchor="start">Answer the person, from verses read before writing. Writings sit beside the answer. Code proves every verse. Live on faithnet.</text>`);

const X = { reader: 72, admit: 188, judge: 304, verses: 432, draft: 560, prove: 676, revise: 792, further: 920, receipt: 1048, back: 1378 };
X.back = 1180;
const h = S / 2 + 8;
const hop = (a, b) => arrow(`M${X[a] + h} ${ROW}H${X[b] - h - 4}`);
const t = (x, y, color, icon, name, sub, o = {}) => tile(x, y, color, icon, name, sub, { size: S, ...o });
out.push(`<rect x="${X.draft - 58}" y="${ROW - 62}" width="${X.revise - X.draft + 116}" height="164" rx="20" fill="none" stroke="${C.dash}" stroke-width="2" stroke-dasharray="7 7"/>`);
out.push(`<text x="${X.prove}" y="${ROW + 92}" text-anchor="middle" class="b">MODEL DRAFTS, CODE PROVES</text>`);
for (const [a, b] of [['reader', 'admit'], ['admit', 'judge'], ['judge', 'verses'], ['verses', 'draft'], ['draft', 'prove'], ['prove', 'revise'], ['revise', 'further'], ['further', 'receipt'], ['receipt', 'back']]) hop(a, b);
t(X.reader, ROW, GREY, 'person', 'Reader', ['or their agent']);
t(X.admit, ROW, '#8b5cf6', 'door', 'Admit', ['who is asking'], { n: 1 });
t(X.judge, ROW, '#ef4444', 'scales', 'Judge', ['records the ask'], { n: 2 });
t(X.verses, ROW, '#14b8a6', 'book', 'Choose verses', ['and read them'], { n: 3 });
t(X.draft, ROW, '#f59e0b', 'pen', 'Draft', ['only those verses'], { n: 4 });
t(X.prove, ROW, '#22c55e', 'seal', 'Prove', ['every verse'], { n: 5 });
t(X.revise, ROW, '#0ea5e9', 'loop', 'Revise', ['off-list, too long'], { n: 6 });
t(X.further, ROW, '#a855f7', 'books', 'Read further', ['0 to 3 writings'], { n: 7 });
t(X.receipt, ROW, '#6366f1', 'receipt', 'Receipt', ['skills named'], { n: 8 });
t(X.back, ROW, GREY, 'person', 'Reader', ['answer and links']);

// ── skills flow in
const TOP = 150, ART = 316;
out.push(`<text x="40" y="112" class="b" text-anchor="start" style="fill:${C.skill}">SKILLS FLOW IN</text>`);
t(72, TOP, C.skill, 'file', 'SKILL.md', ['by its author'], { outline: true, size: 56 });
t(216, TOP, C.skill, 'stack', 'Skills registry', ['owned, published'], { outline: true, size: 56 });
t(360, TOP, C.skill, 'box', 'Pinned playbook', ['exact versions'], { outline: true, size: 56 });
arrow(`M108 ${TOP}H176`, { color: C.skill });
arrow(`M252 ${TOP}H320`, { color: C.skill });
// the playbook's cards reach the judge; the answer plan is read from the registry at its newest published version
const BEND = 250;
arrow(`M360 ${TOP + 78}V${BEND - 8}Q360 ${BEND} 352 ${BEND}H${X.judge + 8}Q${X.judge} ${BEND} ${X.judge} ${BEND + 8}V${ART - 40}`, { color: C.skill });
arrow(`M216 ${TOP - 40}V112Q216 100 228 100H${X.draft - 12}Q${X.draft} 100 ${X.draft} 112V${ART - 40}`, { color: C.skill });
t(X.judge, ART, C.skill, 'target', 'Intent', ['12 cards'], { outline: true, size: 56 });
t(X.verses, ART, GREY, 'file', 'Scope, form', ['7 + 10: recorded'], { outline: true, size: 56 });
t(X.draft, ART, C.skill, 'pen', 'Answer plan', ['1: after the Bible'], { outline: true, size: 56 });
arrow(`M${X.judge + 40} ${ART}H${X.verses - 44}`, { color: GREY, dash: true });
const D = ART + 84;
arrow(`M${X.judge} ${D}V${ROW - h - 4}`, { color: C.skill, dash: true });
arrow(`M${X.draft} ${D}V${ROW - h - 4}`, { color: C.skill, dash: true });
note(X.draft + 76, ART - 8, ['The judge records its pick, and the pick changes nothing yet.', 'A wrong pick did as well in testing, so it has to earn a job first.'], { anchor: 'start', color: C.skill });

// ── what the path reads
const LOW = 672, BELOW = ROW + 94;
t(X.verses, LOW, '#22c55e', 'book', 'Signed corpus', ["the edition's own verses"], { outline: true, size: 56 });
arrow(`M${X.verses} ${BELOW}V${LOW - 40}`, { both: true });
t(X.further, LOW, '#14b8a6', 'books', 'The library', ['notes and writings'], { outline: true, size: 56 });
arrow(`M${X.further} ${LOW - 40}V${BELOW}`, { both: false });
t(X.receipt + 90, LOW, '#6366f1', 'vault', 'Run record', ['every skill and version'], { outline: true, size: 56 });
out.push(`<path d="M${X.receipt} ${BELOW}V${LOW - 72}Q${X.receipt} ${LOW - 56} ${X.receipt + 16} ${LOW - 56}H${X.receipt + 74}Q${X.receipt + 90} ${LOW - 56} ${X.receipt + 90} ${LOW - 44}" fill="none" stroke="${C.line}" stroke-width="2" marker-end="url(#a)"/>`);
note(X.judge, ROW + 112, ['recorded only: unsure,', 'and it answers just the same'], {});

// ── from the reader's context: nothing acts yet
const CTX = 810;
out.push(`<text x="${X.draft + 80}" y="${CTX + 104}" text-anchor="middle" class="b">FROM THE READER'S CONTEXT: NOTHING ACTS YET</text>`);
t(X.draft - 10, CTX, GREY, 'person', 'Age band', ['3: a later option'], { outline: true, size: 56 });
t(X.draft + 170, CTX, GREY, 'agent', 'People group', ['reserved, not built'], { outline: true, size: 56 });

// ── legend
const LX = 40, LY = 780;
out.push(`<path d="M${LX} ${LY}h44" stroke="${C.line}" stroke-width="2" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 4}" class="s" text-anchor="start">the question</text>`);
out.push(`<path d="M${LX} ${LY + 26}h44" stroke="${C.skill}" stroke-width="2" marker-end="url(#as)"/><text x="${LX + 58}" y="${LY + 30}" class="s" text-anchor="start">a skill, on its way in</text>`);
out.push(`<path d="M${LX} ${LY + 52}h44" stroke="${C.skill}" stroke-width="2" stroke-dasharray="6 6" marker-end="url(#as)"/><text x="${LX + 58}" y="${LY + 56}" class="s" text-anchor="start">what that skill drives</text>`);
note(LX, LY + 92, ['Grey does not act on the answer.', 'No skill can switch off the proof.'], { anchor: 'start' });
out.push(`<text x="${W - 40}" y="${H - 26}" class="s" text-anchor="end">faithnet.estate/architecture</text>`);

finish(process.argv[2],
  'The Scripture ask, answer first',
  "A question goes through admission to a judge, which records what is being asked and changes nothing. The verses that carry the answer are chosen and read from the signed corpus before anything is written. A model drafts, citing only those verses, and code proves every one; the draft goes back once if it cites another verse or runs long. Up to three writings that truly bear on the answer are chosen from the library and sit beside it, and a receipt names the skills used. Intent cards reach the judge through a pinned playbook, and one answer plan reaches the draft from the registry. Scopes and forms are recorded and do not act; age bands are a later option; a people-group skill is reserved and not built.");
