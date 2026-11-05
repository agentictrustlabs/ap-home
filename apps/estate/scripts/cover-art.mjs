// Draws the art on the estate's cover page (assets/cover.svg): the estate in the middle, and around it what every agent in it has.
// Decorative, no words, no background (the cover's own colour shows through).
//   node scripts/cover-art.mjs assets/cover.svg
import { C, picture } from './picture-kit.mjs';
const W = 600, H = 460, cx = 300, cy = 230;
const { out, tile, finish } = picture(W, H);
const ring = [['person', '#8b5cf6'], ['key', '#22c55e'], ['scales', '#ef4444'], ['vault', '#6366f1'], ['receipt', '#f59e0b'], ['agent', '#0ea5e9'], ['book', '#3b82f6'], ['graph', '#14b8a6']];
const at = (i) => { const a = (i / ring.length) * 2 * Math.PI - Math.PI / 2; return [Math.round(cx + 232 * Math.cos(a)), Math.round(cy + 170 * Math.sin(a))]; };
out.push(`<ellipse cx="${cx}" cy="${cy}" rx="232" ry="170" fill="none" stroke="${C.dash}" stroke-width="2" stroke-dasharray="6 8"/>`);
ring.forEach((_, i) => { const [x, y] = at(i); out.push(`<path d="M${cx} ${cy}L${x} ${y}" stroke="${C.dash}" stroke-width="2"/>`); });
ring.forEach(([icon, color], i) => { const [x, y] = at(i); tile(x, y, color, icon, '', [], { size: 64 }); });
tile(cx, cy, C.skill, 'home', '', [], { size: 112 });
finish(process.argv[2], 'The estate and what every agent in it has', 'Decorative.');
