// Draws the picture for /architecture/logic-and-the-model: what is fixed before the model writes, what is checked after, the three
// ways it goes wrong as measured, and the five kinds of statement with who should hold each.
//   node scripts/logic-and-model.mjs assets/architecture/logic-and-model.svg
// The PNG beside it (the link preview) is that SVG rendered at 2x in a browser.
import { C, picture } from './picture-kit.mjs';
const W = 1460, H = 930, ROW = 350, S = 64;
const HELD = '#3b82f6', MODEL = '#f59e0b', RISK = '#ef4444';
const { out, esc, tile, arrow, note, finish } = picture(W, H);
const t = (x, y, color, icon, name, sub, o = {}) => tile(x, y, color, icon, name, sub, { size: S, ...o });
const badge = (x, y, n) => out.push(`<circle cx="${x}" cy="${y}" r="11" fill="${C.bg}" stroke="${RISK}" stroke-width="2"/><text x="${x}" y="${y + 4}" text-anchor="middle" class="k">${n}</text>`);

out.push(`<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>`);
out.push(`<text x="40" y="52" class="h">Logic, ontology and the model: who decides what</text>`);
out.push(`<text x="40" y="78" class="s" text-anchor="start">Two projects on one harness: translating the Bible, and answering questions about it. Divide the work by the kind of statement, not by the step.</text>`);

// ── before the model writes
const L = { facts: 125, decisions: 305, may: 485 }, R = { checks: 970, judge: 1150, record: 1330 }, MX = 725, MS = 92;
out.push(`<rect x="40" y="${ROW - 84}" width="545" height="196" rx="18" fill="${C.panel}" stroke="${C.dash}" stroke-width="1.5"/>`);
out.push(`<text x="58" y="${ROW - 58}" class="b" text-anchor="start" style="fill:${HELD}">BEFORE IT WRITES: DATA AND ONTOLOGY</text>`);
t(L.facts, ROW, HELD, 'graph', 'Facts of the text', ['who speaks, who is', 'meant, every word']);
t(L.decisions, ROW, HELD, 'seal', 'Our decisions', ['terms, conventions,', 'the standpoint']);
t(L.may, ROW, HELD, 'key', 'What it may see', ['no existing Bible,', 'nothing after its time']);
arrow(`M585 ${ROW}H${MX - MS / 2 - 8}`);

// ── the model, and what it remembers
tile(MX, ROW, MODEL, 'spark', 'The model', ['reads the whole passage', 'and writes it once'], { size: MS });
tile(MX, 150, MODEL, 'books', '', [], { size: 56, outline: true });
note(MX - 42, 146, ['What the model remembers'], { anchor: 'end', cls: 'n' });
note(MX - 42, 165, ['its training is its skill, and its bias'], { anchor: 'end' });
arrow(`M${MX} 182V${ROW - MS / 2 - 8}`, { color: MODEL, dash: true });
badge(MX - 196, 216, 1);
note(MX - 176, 221, ['It recites'], { anchor: 'start', cls: 't' });
note(MX - 14, 240, ['36% of published verses are close to an existing Bible'], { anchor: 'end', color: RISK });

// ── after it writes
out.push(`<rect x="880" y="${ROW - 84}" width="540" height="196" rx="18" fill="${C.panel}" stroke="${C.dash}" stroke-width="1.5"/>`);
out.push(`<text x="898" y="${ROW - 58}" class="b" text-anchor="start" style="fill:${HELD}">AFTER IT WRITES</text>`);
t(R.checks, ROW, HELD, 'check', 'Checks by code', ['what code can decide']);
t(R.judge, ROW, MODEL, 'scales', 'A judge', ['another model family,', 'tested with planted errors']);
t(R.record, ROW, HELD, 'receipt', 'Record', ['what was decided,', 'and by what']);
arrow(`M${R.checks + 40} ${ROW}H${R.judge - 44}`);
arrow(`M${R.judge + 40} ${ROW}H${R.record - 44}`);
arrow(`M${MX + MS / 2 + 4} ${ROW - 13}H876`);
arrow(`M876 ${ROW + 15}H${MX + MS / 2 + 8}`, { color: RISK, dash: true });
badge(826, ROW + 15, 2);
badge(742, 492, 2);
note(762, 497, ['It writes to pass the check'], { anchor: 'start', cls: 't' });
note(730, 516, ['verses patched until a check passed had 40 times the error rate'], { anchor: 'start', color: RISK });

// the judge shares the memory
arrow(`M${MX + 32} 150H${R.judge}V${ROW - S / 2 - 26}`, { color: MODEL, dash: true });
badge(R.judge + 24, 176, 3);
note(R.judge + 44, 181, ['The judge prefers the familiar'], { anchor: 'start', cls: 't' });
note(R.judge + 14, 200, ['its winner is closer to an existing', 'Bible two times in three'], { anchor: 'start', color: RISK });

// ── the five kinds of statement
const SY = 600, BW = 264, BH = 176;
out.push(`<text x="40" y="${SY - 22}" class="b" text-anchor="start">FIVE KINDS OF STATEMENT, AND WHO SHOULD HOLD EACH</text>`);
[
  ['What the text is', 'Held as data', HELD, ['source words, speakers,', 'people, places, dates'], 'does not change'],
  ['What we decided', 'Held in the ontology', HELD, ['terms, conventions, canon,', 'whose standpoint answers'], 'matters more'],
  ['How to read and write', 'Left to the model', MODEL, ['grammar, sense, flow,', 'the shape of an answer'], 'rules for it expire'],
  ['Was it done?', 'Decided by code', HELD, ['cited, aligned, in range,', 'a quotation mark closed'], 'does not change'],
  ['Is it good?', 'Held well by no one yet', RISK, ["a model's taste, tested;", 'a person, for a sample'], 'the weakest part'],
].forEach(([name, held, color, lines, grows], i) => {
  const x = 40 + i * (BW + 15), cx = x + BW / 2;
  out.push(`<rect x="${x}" y="${SY}" width="${BW}" height="${BH}" rx="14" fill="${C.panel}" stroke="${color}" stroke-width="2"/>`);
  out.push(`<text x="${cx}" y="${SY + 34}" text-anchor="middle" class="n">${esc(name)}</text>`);
  out.push(`<text x="${cx}" y="${SY + 58}" text-anchor="middle" class="t" style="fill:${color}">${esc(held)}</text>`);
  lines.forEach((l, k) => out.push(`<text x="${cx}" y="${SY + 86 + k * 17}" text-anchor="middle" class="s">${esc(l)}</text>`));
  out.push(`<path d="M${x + 24} ${SY + 122}H${x + BW - 24}" stroke="${C.dash}" stroke-width="1"/>`);
  out.push(`<text x="${cx}" y="${SY + 144}" text-anchor="middle" class="s">as models grow</text>`);
  out.push(`<text x="${cx}" y="${SY + 162}" text-anchor="middle" class="t">${esc(grows)}</text>`);
});

// ── legend
const LY = SY + BH + 44;
out.push(`<rect x="40" y="${LY - 11}" width="22" height="14" rx="4" fill="${HELD}"/><text x="72" y="${LY + 1}" class="s" text-anchor="start">held outside the model</text>`);
out.push(`<rect x="270" y="${LY - 11}" width="22" height="14" rx="4" fill="${MODEL}"/><text x="302" y="${LY + 1}" class="s" text-anchor="start">a model</text>`);
out.push(`<path d="M400 ${LY - 4}h44" stroke="${RISK}" stroke-width="2" stroke-dasharray="6 6"/><text x="456" y="${LY + 1}" class="s" text-anchor="start">a way it goes wrong, as measured here</text>`);
note(40, LY + 40, ['A rule that teaches the model its craft expires with the next model. A rule that states a fact, a decision or a permission does not.'], { anchor: 'start' });
out.push(`<text x="${W - 40}" y="${H - 26}" class="s" text-anchor="end">faithnet.estate/architecture</text>`);

finish(process.argv[2],
  'Logic, ontology and the model: who decides what',
  'A diagram in two parts. Above, one run: before the model writes, data and the ontology fix the facts of the text, our decisions and what the model may see; the model reads the whole passage and writes it once; after it writes, code checks what code can decide, a judge from another model family is tested with planted errors, and the run is recorded. What the model remembers from training feeds both the model and the judge. Three ways it goes wrong are marked: it recites (36% of published verses are close to an existing Bible), it writes to pass the check (verses patched until a check passed had 40 times the error rate), and the judge prefers the familiar (its winner is closer to an existing Bible two times in three). Below, five kinds of statement and who should hold each: what the text is, held as data; what we decided, held in the ontology; how to read and write, left to the model; whether it was done, decided by code; and whether it is good, held well by no one yet. Under each is what happens as models grow: the first and fourth do not change, the second matters more, rules for the third expire, and the fifth is the weakest part.');
