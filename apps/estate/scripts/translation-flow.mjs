// Draws the translation harness for /architecture/translation-harness. The SVG in assets/architecture/ is this script's output:
//   node scripts/translation-flow.mjs assets/architecture/translation-flow.svg
// The PNG beside it (the link preview) is that SVG rendered at 2x in a browser.
// The numbered tiles are the steps the page lists beside the picture; their centres are repeated in src/architecture.ts (`at`).
import { C, picture } from './picture-kit.mjs';
const W = 1460, H = 1040, ROW = 410, ROW2 = 700, S = 64;
const { out, tile, arrow, note, finish } = picture(W, H);

out.push(`<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>`);
out.push(`<text x="40" y="52" class="h">How the translation agent translates the Bible</text>`);
out.push(`<text x="40" y="78" class="s" text-anchor="start">The harness behind RBS: Hebrew, Aramaic and Greek into American English. It runs one passage at a time, and the edition is built from what the passages leave.</text>`);

const X = { bible: 72, cut: 188, read: 304, admit: 420, draft: 560, align: 676, check: 792, revise: 908, keep: 1024, propose: 1164, store: 1300 };
const Y = { cut: 188, assemble: 420, audit: 660, publish: 900, reader: 1100, seed: 1264 };
const h = S / 2 + 8;
const t = (x, y, color, icon, name, sub, o = {}) => tile(x, y, color, icon, name, sub, { size: S, ...o });

// ── what the run stands on (top lane)
const TOP = 170;
out.push(`<text x="40" y="${TOP - 56}" class="b" text-anchor="start" style="fill:${C.skill}">BUILT BEFORE ANY DRAFT</text>`);
t(220, TOP, C.skill, 'book', 'Frozen source', ['every token, by verse'], { outline: true });
t(420, TOP, C.skill, 'graph', 'Knowledge base', ['people, places, concepts'], { outline: true });
t(X.draft + 60, TOP, C.skill, 'layers', 'Story and meaning', ['per book, period sources'], { outline: true });
t(X.check + 10, TOP, C.skill, 'file', 'Brief and skills', ['what the drafter is told'], { outline: true });
t(X.keep, TOP, C.skill, 'stack', 'Ontology', ['the rules, as data'], { outline: true });
const IN = TOP + 86, BOX = ROW - 116;
arrow(`M220 ${IN}V${ROW - 96}Q220 ${ROW - 76} 240 ${ROW - 76}H${X.read - 28}Q${X.read - 12} ${ROW - 76} ${X.read - 12} ${ROW - 60}V${ROW - h - 4}`, { color: C.skill });
arrow(`M420 ${IN}V${ROW - 100}Q420 ${ROW - 84} 404 ${ROW - 84}H${X.read + 28}Q${X.read + 12} ${ROW - 84} ${X.read + 12} ${ROW - 68}V${ROW - h - 4}`, { color: C.skill });
for (const x of [X.draft + 60, X.check + 10, X.keep]) arrow(`M${x} ${IN}V${BOX}`, { color: C.skill });
note(232, ROW - 118, ['no English edition, ever'], { anchor: 'start', color: C.skill });
note(X.keep + 14, IN + 22, ['spelling, numbers,', 'free words, names'], { anchor: 'start', color: C.skill });

// ── row one: one passage
out.push(`<text x="40" y="${ROW - 140}" class="b" text-anchor="start">ONE PASSAGE</text>`);
out.push(`<rect x="${X.draft - 66}" y="${ROW - 108}" width="${X.keep - X.draft + 132}" height="216" rx="20" fill="none" stroke="${C.dash}" stroke-width="2" stroke-dasharray="7 7"/>`);
out.push(`<text x="${X.keep + 56}" y="${ROW + 96}" text-anchor="end" class="b">A MODEL WRITES, CODE CHECKS</text>`);
const hop = (a, b) => arrow(`M${X[a] + h} ${ROW}H${X[b] - h - 4}`);
for (const [a, b] of [['bible', 'cut'], ['cut', 'read'], ['read', 'admit'], ['admit', 'draft'], ['draft', 'align'], ['align', 'check'], ['revise', 'keep'], ['keep', 'propose'], ['propose', 'store']]) hop(a, b);
arrow(`M${X.check + h} ${ROW}H${X.revise - h - 4}`, { dash: true });
arrow(`M${X.revise} ${ROW - h}C${X.revise} ${ROW - 84} ${X.align} ${ROW - 84} ${X.align} ${ROW - h - 4}`, { dash: true });
note((X.align + X.revise) / 2, ROW - 84, ['only if a check fails, up to two rounds']);
t(X.bible, ROW, '#64748b', 'books', 'The Bible', ['66 books,', '31,085 verses']);
t(X.cut, ROW, '#8b5cf6', 'fork', 'Cut', ['into passages'], { n: 1 });
t(X.read, ROW, '#3b82f6', 'book', 'Read', ['source only'], { n: 2 });
t(X.admit, ROW, '#14b8a6', 'funnel', 'Admit', ['what it may use'], { n: 3 });
t(X.draft, ROW, '#f59e0b', 'pen', 'Draft', ['words + alignment'], { n: 4 });
t(X.align, ROW, '#eab308', 'link', 'Align', ['by code'], { n: 5 });
t(X.check, ROW, '#22c55e', 'check', 'Check', ['verse by verse'], { n: 6 });
t(X.revise, ROW, '#0ea5e9', 'loop', 'Revise', ['told what failed'], { n: 7 });
t(X.keep, ROW, '#ef4444', 'scales', 'Keep', ['the best pass'], { n: 8 });
t(X.propose, ROW, '#a855f7', 'receipt', 'Propose', ['never approved'], { n: 9 });
t(X.store, ROW, '#64748b', 'vault', 'Translation store', ['every proposal, kept'], { outline: true, size: 56 });

// ── from the store down to row two
const R2 = ROW2 - 80;
out.push(`<text x="40" y="${R2}" class="b" text-anchor="start">THE WHOLE EDITION</text>`);
out.push(`<path d="M${X.store} ${ROW + 84}V${ROW2 - 126}Q${X.store} ${ROW2 - 110} ${X.store - 16} ${ROW2 - 110}H${Y.assemble + 16}Q${Y.assemble} ${ROW2 - 110} ${Y.assemble} ${ROW2 - 94}V${ROW2 - h - 4}" fill="none" stroke="${C.line}" stroke-width="2" marker-end="url(#a)"/>`);

// ── row two: the edition
const hop2 = (a, b, o) => arrow(`M${Y[a] + h} ${ROW2}H${Y[b] - h - 4}`, o);
t(Y.cut, ROW2, '#64748b', 'book', 'Published edition', ['the base of a new one'], { outline: true, size: 56 });
arrow(`M${Y.cut + 38} ${ROW2}H${Y.assemble - h - 4}`);
hop2('assemble', 'audit'); hop2('audit', 'publish'); hop2('publish', 'reader'); hop2('reader', 'seed');
t(Y.assemble, ROW2, '#6366f1', 'layers', 'Assemble', ['verse by verse'], { n: 10 });
t(Y.audit, ROW2, '#ec4899', 'search', 'Audit', ['another model reads'], { n: 11 });
t(Y.publish, ROW2, '#10b981', 'seal', 'Publish', ['a signed root'], { n: 12 });
t(Y.reader, ROW2, '#22c55e', 'book', 'Signed corpus', ['verses with proofs'], { outline: true, size: 56 });
t(Y.seed, ROW2, '#64748b', 'person', 'Reader', ['every verse says', 'what it has passed']);

// the repair loop: from the audit back up to the passage row
arrow(`M${Y.audit} ${ROW2 - h}V${ROW + 150}Q${Y.audit} ${ROW + 134} ${Y.audit - 16} ${ROW + 134}H${X.read + 16}Q${X.read} ${ROW + 134} ${X.read} ${ROW + 118}V${ROW + 86}`, { color: "#ec4899", dash: true });
note(X.read + 20, ROW + 154, ['a confirmed defect: the verses around it are', 'drafted again, and the new verse must pass a rule'], { anchor: 'start', color: '#ec4899' });

// ── below
const LOW = 880, D = ROW2 + 92;
t(Y.assemble, LOW, '#6366f1', 'chat', 'A reader model', ['our English only'], { outline: true, size: 56 });
arrow(`M${Y.assemble} ${D}V${LOW - 36}`, { both: true });
t(Y.audit, LOW, '#ec4899', 'scales', 'Two model families', ['one finds, one verifies'], { outline: true, size: 56 });
arrow(`M${Y.audit} ${D}V${LOW - 36}`, { both: true });
t(Y.publish, LOW, '#10b981', 'file', 'Change rows', ['every changed verse defended'], { outline: true, size: 56 });
arrow(`M${Y.publish} ${D}V${LOW - 36}`);

// ── legend
const LX = 40, LY = 840;
out.push(`<path d="M${LX} ${LY}h44" stroke="${C.line}" stroke-width="2" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 4}" class="s" text-anchor="start">the text</text>`);
out.push(`<path d="M${LX} ${LY + 26}h44" stroke="${C.skill}" stroke-width="2" marker-end="url(#as)"/><text x="${LX + 58}" y="${LY + 30}" class="s" text-anchor="start">what a run stands on</text>`);
out.push(`<path d="M${LX} ${LY + 52}h44" stroke="${C.line}" stroke-width="2" stroke-dasharray="6 6" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 56}" class="s" text-anchor="start">only when needed</text>`);
note(LX, LY + 96, ['No person reviews this edition.', 'A verse is replaced only by rule,', 'and says what it has passed.'], { anchor: 'start' });
out.push(`<text x="${W - 40}" y="${H - 26}" class="s" text-anchor="end">faithnet.estate/architecture</text>`);

finish(process.argv[2],
  'How the translation agent translates the Bible: one passage at a time, then the whole edition',
  'Each book is cut into passages. For a passage the agent reads only the source, admits what it may use, a model drafts words and an alignment, code aligns and checks each verse, a model revises up to twice if a check fails, the best pass is kept and proposed. The edition is assembled verse by verse from the proposals, audited by another model family with confirmed defects sent back to be drafted again, and published under a signed root.');
