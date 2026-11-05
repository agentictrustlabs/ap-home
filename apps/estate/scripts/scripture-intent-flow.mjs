// Draws the Scripture Agent's ask flow as it is being built (the intent stage): the judge first, and the categories of skills that drive each stage.
//   node scripts/scripture-intent-flow.mjs assets/architecture/scripture-intent-flow.svg
// The PNG beside it (the link preview) is that SVG rendered at 2x in a browser. It is labelled "in testing": the live flow is scripture-ask-flow.
import { C, picture } from './picture-kit.mjs';
const W = 1460, H = 990, ROW = 480, S = 64;
const { out, tile, arrow, note, finish } = picture(W, H);

// ── frame and titles
out.push(`<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>`);
out.push(`<text x="40" y="52" class="h">The Scripture ask with a judge first (in testing, not live)</text>`);
out.push(`<text x="40" y="78" class="s" text-anchor="start">What the reader is asking chooses the skills, and the skills drive each stage. The model drafts. Code proves, under every skill.</text>`);

// ── main row
const X = { reader: 72, admit: 188, judge: 304, plan: 420, gather: 536, gate: 652, draft: 790, prove: 906, revise: 1022, enrich: 1150, receipt: 1264, back: 1378 };
const h = S / 2 + 8;
const hop = (a, b) => arrow(`M${X[a] + h} ${ROW}H${X[b] - h - 4}`);
const t = (x, y, color, icon, name, sub, o = {}) => tile(x, y, color, icon, name, sub, { size: S, ...o });
out.push(`<rect x="${X.draft - 66}" y="${ROW - 62}" width="${X.revise - X.draft + 132}" height="164" rx="20" fill="none" stroke="${C.dash}" stroke-width="2" stroke-dasharray="7 7"/>`);
out.push(`<text x="${X.prove}" y="${ROW + 92}" text-anchor="middle" class="b">MODEL DRAFTS, CODE PROVES</text>`);
for (const [a, b] of [['reader', 'admit'], ['admit', 'judge'], ['judge', 'plan'], ['plan', 'gather'], ['gather', 'gate'], ['gate', 'draft'], ['draft', 'prove'], ['prove', 'revise'], ['revise', 'enrich'], ['enrich', 'receipt'], ['receipt', 'back']]) hop(a, b);
t(X.reader, ROW, '#64748b', 'person', 'Reader', ['or their agent']);
t(X.admit, ROW, '#8b5cf6', 'door', 'Admit', ['who is asking']);
t(X.judge, ROW, '#ef4444', 'scales', 'Judge', ['an intent, or hold']);
t(X.plan, ROW, '#3b82f6', 'plan', 'Plan', ['from the scope']);
t(X.gather, ROW, '#14b8a6', 'search', 'Gather', ['what it holds']);
t(X.gate, ROW, '#eab308', 'funnel', 'Gate', ['the scope decides']);
t(X.draft, ROW, '#f59e0b', 'pen', 'Draft', ['answer first']);
t(X.prove, ROW, '#22c55e', 'seal', 'Prove', ['every verse']);
t(X.revise, ROW, '#0ea5e9', 'loop', 'Revise', ['once, if needed']);
t(X.enrich, ROW, '#a855f7', 'layers', 'Enrich', ['at cited verses']);
t(X.receipt, ROW, '#6366f1', 'receipt', 'Receipt', ['skills named']);
t(X.back, ROW, '#64748b', 'person', 'Reader', ['a checked answer']);

// ── skills flow in, from the question
const TOP = 148, ART = 288;
out.push(`<text x="40" y="112" class="b" text-anchor="start" style="fill:${C.skill}">SKILLS FLOW IN</text>`);
t(72, TOP, C.skill, 'file', 'SKILL.md', ['by its author'], { outline: true, size: 56 });
t(216, TOP, C.skill, 'stack', 'Skills registry', ['owned, published'], { outline: true, size: 56 });
t(360, TOP, C.skill, 'box', 'Pinned playbook', ['exact versions'], { outline: true, size: 56 });
arrow(`M${72 + 36} ${TOP}H${216 - 40}`, { color: C.skill });
arrow(`M${216 + 36} ${TOP}H${360 - 40}`, { color: C.skill });
// the rail from the playbook, one drop to each artifact the question selects
out.push(`<path d="M${360 + 36} ${TOP}H${X.draft - 16}Q${X.draft} ${TOP} ${X.draft} ${TOP + 16}V${ART - 36}" fill="none" stroke="${C.skill}" stroke-width="2"/>`);
arrow(`M${X.gather} ${TOP}V${ART - 40}`, { color: C.skill });
arrow(`M${X.draft} ${ART - 44}V${ART - 40}`, { color: C.skill });
out.push(`<path d="M452 ${TOP}V${ART - 16}Q452 ${ART} 436 ${ART}H${X.judge + 44}" fill="none" stroke="${C.skill}" stroke-width="2" marker-end="url(#as)"/>`);
t(X.judge, ART, C.skill, 'target', 'Intent', ['12: what is asked'], { outline: true, size: 56 });
t(X.gather, ART, C.skill, 'books', 'Scope', ['7: what is gathered'], { outline: true, size: 56 });
t(X.draft, ART, C.skill, 'pen', 'Form', ['10: the shape'], { outline: true, size: 56 });
note(X.draft + 44, ART - 8, ['one judge call over the intent cards:', 'each intent names one scope and one form'], { anchor: 'start', color: C.skill });
// artifact → the stages it drives
const D = ART + 84;
arrow(`M${X.judge} ${D}V${ROW - h - 4}`, { color: C.skill, dash: true });
arrow(`M${X.gather - 22} ${D}Q${X.gather - 22} ${D + 14} ${X.gather - 42} ${D + 14}H${X.plan + 16}Q${X.plan} ${D + 14} ${X.plan} ${D + 30}V${ROW - h - 4}`, { color: C.skill, dash: true });
arrow(`M${X.gather} ${D}V${ROW - h - 4}`, { color: C.skill, dash: true });
arrow(`M${X.gather + 22} ${D}Q${X.gather + 22} ${D + 14} ${X.gather + 42} ${D + 14}H${X.gate - 16}Q${X.gate} ${D + 14} ${X.gate} ${D + 30}V${ROW - h - 4}`, { color: C.skill, dash: true });
arrow(`M${X.draft} ${D}V${ROW - h - 4}`, { color: C.skill, dash: true });

// ── what the path reads, below the row
const LOW = 672, BELOW = ROW + 94;
t(X.gather, LOW, '#14b8a6', 'books', 'The library', ['notes, writings, originals'], { outline: true, size: 56 });
arrow(`M${X.gather} ${BELOW}V${LOW - 40}`, { both: true });
t(X.prove, LOW, '#22c55e', 'book', 'Signed corpus', ["the edition's own verses"], { outline: true, size: 56 });
arrow(`M${X.prove} ${ROW + 106}V${LOW - 40}`, { both: true });
t(X.receipt, LOW, '#6366f1', 'vault', 'Run record', ['every skill and version'], { outline: true, size: 56 });
arrow(`M${X.receipt} ${BELOW}V${LOW - 40}`);
// a hold
note(X.judge, ROW + 112, ['unsure? no skill applies', "and it runs today's path"], {});

// ── skills flow in, from the reader's context
const CTX = 840, RISE = 752;
out.push(`<text x="${X.draft}" y="${CTX + 104}" text-anchor="middle" class="b" style="fill:${C.skill}">FROM THE READER'S CONTEXT: STATED, NEVER GUESSED, CHOSEN BY RULE</text>`);
t(X.draft - 180, CTX, C.skill, 'book', 'Standpoint', ['2: whose reading leads'], { outline: true, size: 56 });
t(X.draft, CTX, C.skill, 'person', 'Reader', ['11: journey, age band'], { outline: true, size: 56 });
t(X.draft + 180, CTX, '#64748b', 'agent', 'People group', ['reserved, not built'], { outline: true, size: 56 });
arrow(`M${X.draft} ${CTX - 40}V${ROW + 106}`, { color: C.skill, dash: true });
arrow(`M${X.draft - 180} ${CTX - 40}V${RISE + 16}Q${X.draft - 180} ${RISE} ${X.draft - 164} ${RISE}H${X.draft - 34}Q${X.draft - 18} ${RISE} ${X.draft - 18} ${RISE - 16}V${ROW + 106}`, { color: C.skill, dash: true });
arrow(`M${X.draft + 180} ${CTX - 40}V${RISE + 16}Q${X.draft + 180} ${RISE} ${X.draft + 164} ${RISE}H${X.draft + 34}Q${X.draft + 18} ${RISE} ${X.draft + 18} ${RISE - 16}V${ROW + 106}`, { color: '#64748b', dash: true });

// ── legend
const LX = 40, LY = 790;
out.push(`<path d="M${LX} ${LY}h44" stroke="${C.line}" stroke-width="2" marker-end="url(#a)"/><text x="${LX + 58}" y="${LY + 4}" class="s" text-anchor="start">the question</text>`);
out.push(`<path d="M${LX} ${LY + 26}h44" stroke="${C.skill}" stroke-width="2" marker-end="url(#as)"/><text x="${LX + 58}" y="${LY + 30}" class="s" text-anchor="start">a skill, on its way in</text>`);
out.push(`<path d="M${LX} ${LY + 52}h44" stroke="${C.skill}" stroke-width="2" stroke-dasharray="6 6" marker-end="url(#as)"/><text x="${LX + 58}" y="${LY + 56}" class="s" text-anchor="start">what that skill drives</text>`);
note(LX, LY + 92, ['Each skill acts only after it beats today\'s answer', 'in blind comparison. None can switch off the proof.'], { anchor: 'start' });
out.push(`<text x="${W - 40}" y="${H - 26}" class="s" text-anchor="end">faithnet.estate/architecture</text>`);

finish(process.argv[2],
  'The Scripture ask with a judge first: in testing, not live',
  "A question goes from the reader through admission to a judge, which picks one of twelve intents or holds. An intent names a scope, which drives planning, gathering and the gate, and a form, which drives the draft. The reader's stated context adds a standpoint and a reader skill to the draft by rule; a people-group skill is reserved and not built. A model drafts, code proves every verse against the signed corpus, the draft is revised once if a check failed, the answer is enriched and it returns with a receipt naming every skill used. Skills reach the judge and the stages from the skills registry through a pinned playbook. If the judge is unsure, no skill applies and the question runs today's path.");
