// Draws the Scripture Agent's ask flow for /architecture/scripture-ask. The SVG in assets/architecture/ is this script's output:
//   node scripts/scripture-ask-flow.mjs assets/architecture/scripture-ask-flow.svg
// The PNG beside it (the link preview) is that SVG rendered at 2x in a browser.
// The numbered tiles are the steps the page lists beside the picture; their centres are repeated in src/architecture.ts (`at`).
import { C, picture } from './picture-kit.mjs';
const W = 1460, H = 900, ROW = 470, S = 64;
const { out, tile, arrow, note, finish } = picture(W, H);

// ── frame and titles
out.push(`<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>`);
out.push(`<text x="40" y="52" class="h">How the Scripture Agent answers a question</text>`);
out.push(`<text x="40" y="78" class="s" text-anchor="start">The ask harness of the Scripture Agent at scripture.faithnet.io, with the skills that flow into it. The model drafts. Code proves.</text>`);

// ── main row positions
const X = { reader: 72, admit: 188, route: 304, choose: 420, gather: 536, gate: 652, draft: 790, prove: 906, revise: 1022, enrich: 1150, receipt: 1264, back: 1378 };
const h = S / 2 + 8;
const hop = (a, b) => arrow(`M${X[a] + h} ${ROW}H${X[b] - h - 4}`);
const t = (x, y, color, icon, name, sub, o = {}) => tile(x, y, color, icon, name, sub, { size: S, ...o });

// the draft-and-prove box
out.push(`<rect x="${X.draft - 66}" y="${ROW - 86}" width="${X.revise - X.draft + 132}" height="196" rx="20" fill="none" stroke="${C.dash}" stroke-width="2" stroke-dasharray="7 7"/>`);
out.push(`<text x="${X.revise + 50}" y="${ROW - 62}" text-anchor="end" class="b">MODEL DRAFTS, CODE PROVES</text>`);

for (const [a, b] of [['reader', 'admit'], ['admit', 'route'], ['route', 'choose'], ['choose', 'gather'], ['gather', 'gate'], ['gate', 'draft'], ['draft', 'prove'], ['prove', 'revise'], ['revise', 'enrich'], ['enrich', 'receipt'], ['receipt', 'back']]) hop(a, b);
t(X.reader, ROW, '#64748b', 'person', 'Reader', ['or their agent']);
t(X.admit, ROW, '#8b5cf6', 'door', 'Admit', ['who is asking'], { n: 1 });
t(X.route, ROW, '#3b82f6', 'fork', 'Route', ['verse, or any'], { n: 2 });
t(X.choose, ROW, '#ef4444', 'scales', 'Choose a plan', ['a plan, or none'], { n: 3 });
t(X.gather, ROW, '#14b8a6', 'search', 'Gather', ['what it holds'], { n: 4 });
t(X.gate, ROW, '#eab308', 'funnel', 'Gate', ['the plan decides'], { n: 5 });
t(X.draft, ROW, '#f59e0b', 'pen', 'Draft', ['answer first'], { n: 6 });
t(X.prove, ROW, '#22c55e', 'seal', 'Prove', ['every verse'], { n: 7 });
t(X.revise, ROW, '#0ea5e9', 'loop', 'Revise', ['once, if needed'], { n: 8 });
t(X.enrich, ROW, '#a855f7', 'layers', 'Enrich', ['at cited verses'], { n: 9 });
t(X.receipt, ROW, '#6366f1', 'receipt', 'Receipt', ['what it ran'], { n: 10 });
t(X.back, ROW, '#64748b', 'person', 'Reader', ['a checked answer']);

// ── skills flow in (top lane)
const TOP = 196;
out.push(`<text x="40" y="${TOP - 62}" class="b" text-anchor="start" style="fill:${C.skill}">SKILLS FLOW IN</text>`);
t(X.reader, TOP, C.skill, 'file', 'SKILL.md', ['by its author'], { outline: true });
t(X.admit, TOP, C.skill, 'stack', 'Skills registry', ['read at ask time'], { outline: true });
arrow(`M${X.reader + h} ${TOP}H${X.admit - h - 4}`, { color: C.skill });
note(X.admit + 52, TOP - 38, ['admitted only if', "Scripture's organization", 'owns it, it is published,', 'and its content matches', 'its commitment'], { anchor: 'start', color: C.skill });
// one rail from the registry, three drops: the card, the policy, the body
const RAIL = 104, drop = (x, dash) => arrow(`M${x - 16} ${RAIL}Q${x} ${RAIL} ${x} ${RAIL + 16}V${ROW - h - 4}`, { color: C.skill, dash });
out.push(`<path d="M${X.admit} ${TOP - h}V${RAIL + 16}Q${X.admit} ${RAIL} ${X.admit + 16} ${RAIL}H${X.draft - 16}" fill="none" stroke="${C.skill}" stroke-width="2"/>`);
drop(X.choose, false); drop(X.gate, true); drop(X.draft, true);
note(X.choose + 12, 300, ["each plan's card,", 'for the judge'], { anchor: 'start', color: C.skill });
note(X.gate + 12, 300, ["the plan's", 'writings policy'], { anchor: 'start', color: C.skill });
note(X.draft + 12, 300, ["the plan's body,", 'for the writer'], { anchor: 'start', color: C.skill });

// ── below the row
const LOW = 668, D = ROW + 94;
t(X.route, LOW, '#3b82f6', 'bolt', 'Verse companion', ['a verse is open: seconds'], { outline: true, size: 56 });
arrow(`M${X.route} ${D}V${LOW - 36}`, { dash: true });
t(X.gather, LOW, '#14b8a6', 'books', 'The library', ['notes, writings, originals'], { outline: true, size: 56 });
arrow(`M${X.gather} ${D}V${LOW - 36}`, { both: true });
t(X.prove, LOW, '#22c55e', 'book', 'Signed corpus', ["the edition's own verses"], { outline: true, size: 56 });
arrow(`M${X.prove} ${D + 22}V${LOW - 36}`, { both: true });
t(X.receipt, LOW, '#6366f1', 'vault', 'Run record', ['every stage, kept'], { outline: true, size: 56 });
arrow(`M${X.receipt} ${D}V${LOW - 36}`);

// ── legend
const LX = 40, LY = 770;
out.push(`<path d="M${LX} ${LY}h44" stroke="${C.line}" stroke-width="2" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 4}" class="s" text-anchor="start">the question</text>`);
out.push(`<path d="M${LX} ${LY + 26}h44" stroke="${C.skill}" stroke-width="2" marker-end="url(#as)"/><text x="${LX + 58}" y="${LY + 30}" class="s" text-anchor="start">a skill, on its way in</text>`);
out.push(`<path d="M${LX} ${LY + 52}h44" stroke="${C.line}" stroke-width="2" stroke-dasharray="6 6" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 56}" class="s" text-anchor="start">only when needed</text>`);
note(LX, LY + 92, ['A plan can only narrow what the writer sees.', 'The proof is code, under every plan.'], { anchor: 'start' });
out.push(`<text x="${W - 40}" y="${H - 26}" class="s" text-anchor="end">faithnet.estate/architecture</text>`);

finish(process.argv[2],
  'How the Scripture Agent answers a question: its ask harness, with skills flowing in',
  "A question goes from the reader through admission and routing. A judge chooses an answer plan or none while the agent gathers what it holds; the plan gates what the writer sees. A model drafts, code proves every quoted verse against the signed corpus, and the draft is revised once if a check failed. The answer is enriched with what the sources say at the cited verses and returned with a receipt. Skills enter from the top: a SKILL.md is published to the skills registry and read when the question arrives; the judge reads each plan's card, the gate applies its writings policy, and the writer reads its body.");
