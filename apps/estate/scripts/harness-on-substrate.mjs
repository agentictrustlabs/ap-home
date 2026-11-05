// Draws the picture for /architecture/harness-needs-substrate (and its link preview, 1920x1080): the harness's ten steps on top,
// the substrate's seven capabilities beneath, and a line from each step to what it takes from the substrate.
//   node scripts/harness-on-substrate.mjs assets/architecture/harness-on-substrate.svg
import { C, picture } from './picture-kit.mjs';
const W = 1920, H = 1080;
const { out, esc, tile, finish } = picture(W, H);
const text = (x, y, s, size, o = {}) => out.push(`<text x="${x}" y="${y}" text-anchor="${o.anchor ?? 'middle'}" style="font-size:${size}px;font-weight:${o.weight ?? 400};fill:${o.fill ?? C.text}${o.spacing ? `;letter-spacing:${o.spacing}` : ''}">${esc(s)}</text>`);

out.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);
text(72, 96, 'Great Agent Harness requires', 50, { anchor: 'start', weight: 700 });
text(72, 156, 'Agentic Primitives Substrate', 50, { anchor: 'start', weight: 700, fill: C.skill });
text(72, 204, 'The loop is the easy part. What makes it trustworthy is what it stands on.', 22, { anchor: 'start', fill: C.muted });

// ── the harness: ten steps
const ROW = 400, S = 88;
const steps = [['Admit', '#8b5cf6', 'door'], ['Playbook', '#3b82f6', 'book'], ['Ground', '#14b8a6', 'target'], ['Judge', '#ef4444', 'scales'], ['Plan', '#f59e0b', 'plan'],
  ['Check', '#eab308', 'check'], ['Authority', '#22c55e', 'key'], ['Execute', '#0ea5e9', 'play'], ['Receipt', '#6366f1', 'receipt'], ['Answer', '#3b82f6', 'chat']];
const sx = (i) => 168 + i * 176;
text(72, ROW - 84, 'THE HARNESS', 16, { anchor: 'start', weight: 700, fill: C.muted, spacing: '.14em' });

// ── the substrate: seven capabilities
const BY = 740, BW = 236, BH = 196;
const blocks = [
  ['Identity', ['Smart Agent accounts', 'names: .me .org .svc', 'keys that can be replaced']],
  ['Admission', ['who is at the door', 'agent-to-agent transport', 'budgets']],
  ['Knowledge', ['the domain ontology', 'skills, by commitment', 'public and private context']],
  ['Orchestration', ['intent, plan, act, observe', 'judge and plan rules', 'the model gateway']],
  ['Authority', ['signed delegations', 'limits kept by contracts', 'revocable at any time']],
  ['Vault', ["the agent's own records", 'read only under a grant', 'kept by its owner']],
  ['Evidence', ['a receipt for each step', 'provenance of each run', 'audit events']],
];
const bx = (i) => 72 + BW / 2 + i * ((W - 144 - BW) / 6);
// what each step takes: indexes into `blocks`
const takes = [[0, 1], [2, 5], [2], [3], [3], [3], [4, 0], [2, 3], [6, 5], [3]];
out.push(`<rect x="40" y="${BY - 40}" width="${W - 80}" height="${BH + 104}" rx="26" fill="${C.panel}" stroke="${C.dash}" stroke-width="2"/>`);
text(72, BY + BH + 42, 'THE SUBSTRATE: AGENTIC PRIMITIVES', 16, { anchor: 'start', weight: 700, fill: C.skill, spacing: '.14em' });
// the lines into one block land side by side, in the order of the steps they come from, so they do not cross at the block
const into = blocks.map((_, b) => steps.map((_, i) => i).filter((i) => takes[i].includes(b)));
steps.forEach(([, color], i) => takes[i].forEach((b, k) => {
  const j = into[b].indexOf(i), n = into[b].length;
  const x0 = sx(i) + (takes[i].length > 1 ? (k ? 10 : -10) : 0), y0 = ROW + S / 2 + 44, x1 = bx(b) + (j - (n - 1) / 2) * 30, y1 = BY - 8;
  out.push(`<path d="M${x0} ${y0}C${x0} ${y0 + 130} ${x1} ${y1 - 130} ${x1} ${y1}" fill="none" stroke="${color}" stroke-width="2.500" stroke-opacity=".8"/><circle cx="${x1}" cy="${y1}" r="5" fill="${color}"/>`);
}));
steps.forEach(([name, color, icon], i) => {
  if (i) out.push(`<path d="M${sx(i - 1) + S / 2 + 8} ${ROW}H${sx(i) - S / 2 - 12}" fill="none" stroke="${C.line}" stroke-width="2" marker-end="url(#a)"/>`);
  tile(sx(i), ROW, color, icon, '', [], { size: S, n: i + 1 });
  text(sx(i), ROW + S / 2 + 32, name, 21, { weight: 650 });
});
blocks.forEach(([name, lines], i) => {
  out.push(`<rect x="${bx(i) - BW / 2}" y="${BY}" width="${BW}" height="${BH}" rx="18" fill="${C.bg}" stroke="${C.dash}" stroke-width="2"/>`);
  text(bx(i), BY + 46, name, 25, { weight: 700 });
  lines.forEach((l, k) => text(bx(i), BY + 88 + k * 30, l, 17, { fill: C.muted }));
});
text(72, H - 26, 'Intelligence may be probabilistic. Authority must not be.', 20, { anchor: 'start', fill: C.muted });
text(W - 72, H - 26, 'faithnet.estate/architecture', 20, { anchor: 'end', fill: C.muted });

finish(process.argv[2], 'Great Agent Harness requires Agentic Primitives Substrate',
  'Two layers. On top, the ten steps of the agent harness: Admit, Playbook, Ground, Judge, Plan, Check, Authority, Execute, Receipt, Answer. Beneath, the seven capabilities of the Agentic Primitives substrate: Identity, Admission, Knowledge, Orchestration, Authority, Vault and Evidence. A line joins each step to what it takes from the substrate.');
