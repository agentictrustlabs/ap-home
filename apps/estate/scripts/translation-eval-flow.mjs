// Draws how translation quality is evaluated, for /architecture/testing-translations. The SVG in assets/architecture/ is this script's output:
//   node scripts/translation-eval-flow.mjs assets/architecture/translation-eval-flow.svg
// The PNG beside it (the link preview) is that SVG rendered at 2x in a browser.
// The numbered tiles are the steps the page lists beside the picture; their centres are repeated in src/architecture.ts (`at`).
import { C, picture } from './picture-kit.mjs';
const W = 1460, H = 1040, ROW = 300, ROW2 = 580, S = 64;
const { out, esc, tile, arrow, note, finish } = picture(W, H);

out.push(`<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>`);
out.push(`<text x="40" y="52" class="h">How we test the quality of a translation</text>`);
out.push(`<text x="40" y="78" class="s" text-anchor="start">No person reviews RBS, so every change to the harness has to prove itself on locked passages, against a second run of the unchanged plan, read blind by another model family.</text>`);

const X = { sets: 110, bounds: 290, plant: 470, arms: 650, checks: 830, judge: 1010, verify: 1190, decide: 1370 };
const Y = { edition: 110, audit: 290, confirm: 470, source: 650, gates: 830, reader: 1010 };
const h = S / 2 + 8;
const t = (x, y, color, icon, name, sub, o = {}) => tile(x, y, color, icon, name, sub, { size: S, ...o });

// ── what keeps the test honest (top lane)
const TOP = 150;
out.push(`<text x="40" y="${TOP - 38}" class="b" text-anchor="start" style="fill:${C.skill}">WHAT KEEPS THE TEST HONEST</text>`);
for (const [x, a, b] of [[X.arms, 'A second identical run', 'the noise, beside every result'], [X.judge, 'Another model family', 'blind, in both orders'], [X.decide, 'Criteria written first', 'before any draft is made']]) {
  const cx = Math.min(x, W - 40 - 112);
  out.push(`<rect x="${cx - 112}" y="${TOP - 22}" width="224" height="48" rx="12" fill="${C.panel}" stroke="${C.skill}" stroke-width="2"/>`);
  out.push(`<text x="${cx}" y="${TOP - 2}" text-anchor="middle" class="t">${esc(a)}</text><text x="${cx}" y="${TOP + 15}" text-anchor="middle" class="s">${esc(b)}</text>`);
  arrow(`M${x} ${TOP + 26}V${ROW - h - 4}`, { color: C.skill });
}

// ── row one: one change to the harness
out.push(`<text x="40" y="${ROW - 64}" class="b" text-anchor="start">ONE CHANGE TO THE HARNESS</text>`);
const ks = Object.keys(X);
for (let i = 0; i < ks.length - 1; i++) arrow(`M${X[ks[i]] + h} ${ROW}H${X[ks[i + 1]] - h - 4}`, ks[i] === 'judge' ? { dash: true } : {});
t(X.sets, ROW, '#8b5cf6', 'vault', 'Lock passages', ['before the test'], { n: 1 });
t(X.bounds, ROW, '#3b82f6', 'scales', 'Floor and ceiling', ['what a score means'], { n: 2 });
t(X.plant, ROW, '#14b8a6', 'target', 'Plant errors', ['to test the checks'], { n: 3 });
t(X.arms, ROW, '#f59e0b', 'pen', 'Draft the arms', ['old plan, new plan'], { n: 4 });
t(X.checks, ROW, '#22c55e', 'check', 'Check by code', ['every verse'], { n: 5 });
t(X.judge, ROW, '#ec4899', 'search', 'Judge blind', ['faithful? readable?'], { n: 6 });
t(X.verify, ROW, '#0ea5e9', 'finger', 'Verify', ['is the error real?'], { n: 7 });
t(X.decide, ROW, '#ef4444', 'seal', 'Decide', ['pass or fail, recorded'], { n: 8 });

// ── row two: the whole edition
out.push(`<text x="40" y="${ROW2 - 64}" class="b" text-anchor="start">THE WHOLE EDITION</text>`);
const ys = Object.keys(Y);
for (let i = 0; i < ys.length - 1; i++) arrow(`M${Y[ys[i]] + h} ${ROW2}H${Y[ys[i + 1]] - h - 4}`);
t(Y.edition, ROW2, '#64748b', 'book', 'Published edition', ['31,085 verses'], { outline: true });
t(Y.audit, ROW2, '#a855f7', 'search', 'Audit', ['every verse is read'], { n: 9 });
t(Y.confirm, ROW2, '#0ea5e9', 'finger', 'Confirm', ['against the source'], { n: 10 });
t(Y.source, ROW2, '#6366f1', 'book', 'Read the fixes', ['token by token'], { n: 11 });
t(Y.gates, ROW2, '#10b981', 'funnel', 'Release gates', ['ready, or open and why'], { n: 12 });
t(Y.reader, ROW2, '#64748b', 'person', 'Reader', ['each verse says', 'what it has passed'], { outline: true });
// a confirmed defect becomes a test
arrow(`M${Y.confirm} ${ROW2 - h}V${ROW + 88}`, { color: '#0ea5e9', dash: true });
note(Y.confirm + 14, ROW2 - 62, ['a confirmed error becomes', 'a planted kind and a check'], { anchor: 'start', color: '#0ea5e9' });

// ── the sets
const SY = 770, BW = 184, BH = 104;
out.push(`<text x="40" y="${SY - 22}" class="b" text-anchor="start">HOW MANY VERSES</text>`);
[
  ['327', 'development', '55 passages, read freely'],
  ['510', 'held out', '73 passages, locked'],
  ['180', 'hard set', '120 open, 60 sealed'],
  ['568', 'skill tests', '60 passages, two sets'],
  ['839', 'planted errors', 'nine kinds, by code'],
  ['1,115', 'stored drafts', 'replayed for false alarms'],
  ['31,085', 'whole edition', 'audit and release gates'],
].forEach(([n, a, b], i) => {
  const x = 40 + i * (BW + 15.6);
  out.push(`<rect x="${x}" y="${SY}" width="${BW}" height="${BH}" rx="14" fill="${C.panel}" stroke="${C.dash}" stroke-width="1.5"/>`);
  out.push(`<text x="${x + BW / 2}" y="${SY + 40}" text-anchor="middle" class="h">${n}</text>`);
  out.push(`<text x="${x + BW / 2}" y="${SY + 64}" text-anchor="middle" class="t">${esc(a)}</text>`);
  out.push(`<text x="${x + BW / 2}" y="${SY + 84}" text-anchor="middle" class="s">${esc(b)}</text>`);
});

// ── legend
const LY = 930;
out.push(`<path d="M40 ${LY}h44" stroke="${C.line}" stroke-width="2" marker-end="url(#a)"/><text x="98" y="${LY + 4}" class="s" text-anchor="start">the test</text>`);
out.push(`<path d="M230 ${LY}h44" stroke="${C.skill}" stroke-width="2" marker-end="url(#as)"/><text x="288" y="${LY + 4}" class="s" text-anchor="start">a guard on the test itself</text>`);
out.push(`<path d="M540 ${LY}h44" stroke="${C.line}" stroke-width="2" stroke-dasharray="6 6" marker-end="url(#a)"/><text x="598" y="${LY + 4}" class="s" text-anchor="start">only when needed</text>`);
note(40, LY + 40, ['A typical comparison reads 180 to 320 verses. That is small, and it is why a gain must be clear of the difference between two identical runs before it counts.'], { anchor: 'start' });
out.push(`<text x="${W - 40}" y="${H - 26}" class="s" text-anchor="end">faithnet.estate/architecture</text>`);

finish(process.argv[2],
  'How we test the quality of a translation',
  'One change to the harness goes through eight steps: the passages are locked before the test; a floor and a ceiling give a score its meaning; errors are planted by code to test the checks; the old plan and the new plan each draft the passages; code checks every verse; another model family judges the two blind, in both orders; a claimed error is verified against the source; and the change passes or fails against criteria written first. Three guards feed the test: a second identical run as the measure of noise, a judge from another model family, and criteria written before any draft. The whole edition has its own row: every verse is audited, a finding is confirmed against the source, each fix is read token by token, and release gates mark every verse ready or open with the reason. A confirmed error becomes a planted kind and a check. A strip gives the number of verses in each set: 327 development, 510 held out, 180 in the hard set, 568 in the skill tests, 839 planted errors, 1,115 stored drafts replayed, and 31,085 in the whole edition.');
