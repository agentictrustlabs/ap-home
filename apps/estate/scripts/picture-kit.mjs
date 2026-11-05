// The shared drawing kit for the architecture pictures: a dark panel, coloured tiles with a line icon, a name and two short
// lines under each, and three kinds of arrow (the ask, a skill on its way in, only when needed). One script per picture uses it.
import { writeFileSync } from 'node:fs';
export const T = 76;
export const C = { bg: '#0b1020', panel: '#111933', line: '#8b95b5', text: '#eef1fb', muted: '#9aa5c7', skill: '#f472b6', dash: '#3a4670' };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// icons, drawn in a 24×24 box
export const I = {
  person: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c.8-4 3.8-6 7.5-6s6.700 2 7.500 6"/>',
  door: '<path d="M10 4h8v16h-8"/><path d="M3 12h10"/><path d="M9.500 8.500 13 12l-3.500 3.500"/>',
  book: '<path d="M5 4.500h10.500a2.500 2.500 0 0 1 2.500 2.500v12.500H7.500A2.500 2.500 0 0 1 5 17z"/><path d="M5 17a2.500 2.500 0 0 1 2.500-2.500H18"/><path d="M9 8.500h5.500"/>',
  target: '<circle cx="12" cy="12" r="7.500"/><circle cx="12" cy="12" r="2.600"/><path d="M12 2.500v3M12 18.500v3M2.500 12h3M18.500 12h3"/>',
  scales: '<path d="M12 4v16M7 20h10M5 7h14"/><path d="M5 7l-2.500 6a2.700 2.700 0 0 0 5 0z"/><path d="M19 7l-2.500 6a2.700 2.700 0 0 0 5 0z"/>',
  plan: '<circle cx="5.500" cy="6" r="2"/><circle cx="5.500" cy="18" r="2"/><circle cx="18.500" cy="12" r="2"/><path d="M7.500 6h4a3 3 0 0 1 3 3v.500M7.500 18h4a3 3 0 0 0 3-3v-.500"/>',
  check: '<path d="M12 3l7.500 3v5.500c0 4.500-3.200 7.800-7.500 9.500-4.300-1.700-7.500-5-7.500-9.500V6z"/><path d="M8.500 12l2.500 2.500 4.500-5"/>',
  key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M17.500 12v3.500M20.500 12v2.500"/>',
  play: '<circle cx="12" cy="12" r="8.500"/><path d="M10 8.500v7l6-3.500z"/>',
  receipt: '<path d="M6 3.500h12v17l-2.400-1.600-2.400 1.600-2.400-1.600-2.400 1.600L6 20.500z"/><path d="M9 8.500h6M9 12h6M9 15.500h3.500"/>',
  chat: '<path d="M4 5.500h16v11H11l-4.500 3.500v-3.500H4z"/><path d="M8 9.500h8M8 12.800h5"/>',
  file: '<path d="M6.500 3.500h7l4 4v13h-11z"/><path d="M13.500 3.500v4h4"/><path d="M9 12h6M9 15.500h6"/>',
  stack: '<ellipse cx="12" cy="6.500" rx="7" ry="2.800"/><path d="M5 6.500v5.500c0 1.500 3.100 2.800 7 2.800s7-1.300 7-2.800V6.500"/><path d="M5 12v5.500c0 1.500 3.100 2.800 7 2.800s7-1.300 7-2.800V12"/>',
  graph: '<circle cx="6" cy="6" r="2.300"/><circle cx="18" cy="7" r="2.300"/><circle cx="12" cy="18" r="2.300"/><path d="M8.200 6.400l7.500.400M7.200 8l3.700 8M16.800 9l-3.700 7"/>',
  box: '<path d="M12 3.500l7.500 4v9l-7.500 4-7.500-4v-9z"/><path d="M4.500 7.500l7.500 4 7.500-4M12 11.500v9"/>',
  spark: '<path d="M12 3.500l1.900 5.600 5.600 1.900-5.600 1.900L12 18.500l-1.900-5.600L4.500 11l5.600-1.900z"/><path d="M18.500 16.500v3M17 18h3"/>',
  home: '<path d="M4 11.500 12 4.500l8 7"/><path d="M6.500 10v9.500h11V10"/><path d="M10 19.500v-5h4v5"/>',
  vault: '<rect x="4" y="4.500" width="16" height="14" rx="2"/><circle cx="12" cy="11.500" r="3"/><path d="M12 8.500v-1M7 18.500v2M17 18.500v2"/>',
  tool: '<path d="M14.500 5a4 4 0 0 0-4.800 5.200L4.500 15.400l2.600 2.600 5.200-5.200A4 4 0 0 0 17.500 8l-2.500 2.500-2-2z"/>',
  plug: '<path d="M9 3.500v4.500M15 3.500v4.500M6.500 8h11v3.500a5.500 5.500 0 0 1-11 0zM12 17v3.500"/>',
  agent: '<rect x="5" y="8" width="14" height="10.500" rx="3"/><path d="M12 8V4.500"/><circle cx="12" cy="3.800" r="1"/><circle cx="9.300" cy="13" r="1.200"/><circle cx="14.700" cy="13" r="1.200"/>',
  fork: '<path d="M4 12h5M9 12c3.5 0 3-5.5 6.5-5.5H19M9 12c3.5 0 3 5.5 6.5 5.5H19"/><path d="M17 4.5l2 2-2 2M17 15.5l2 2-2 2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  funnel: '<path d="M4 5h16l-6 7.5v6l-4 1.5v-7.5z"/>',
  pen: '<path d="M4.5 19.5l1-4.5L16 4.5 19.5 8 9 18.5z"/><path d="M13.5 7l3.5 3.5"/>',
  loop: '<path d="M19 12a7 7 0 1 1-2.2-5.1"/><path d="M19.5 4v4h-4"/>',
  layers: '<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4M4 16l8 4 8-4"/>',
  books: '<path d="M4.5 4.5h4v15h-4zM8.5 4.5h4v15h-4z"/><path d="M14.200 6l3.600-1 3 13.500-3.600 1z"/>',
  bolt: '<path d="M13 3.5L5.5 13.5H11l-1 7 7.5-10H12z"/>',
  seal: '<circle cx="12" cy="10" r="6"/><path d="M9.300 10l2 2 3.400-3.800"/><path d="M8.500 15l-1.500 5.500 5-2.500 5 2.500-1.500-5.500"/>',
};

/** A picture W×H: push raw SVG to `out`, or use tile / arrow / note; `finish` writes the file. */
export function picture(W, H) {
  const out = [];
  const tile = (x, y, color, icon, name, sub = [], o = {}) => {
    const s = o.size ?? T, r = o.outline ? 16 : 18;
    out.push(`<g>`);
    out.push(o.outline
      ? `<rect x="${x - s / 2}" y="${y - s / 2}" width="${s}" height="${s}" rx="${r}" fill="${C.panel}" stroke="${color}" stroke-width="2.200"/>`
      : `<rect x="${x - s / 2}" y="${y - s / 2}" width="${s}" height="${s}" rx="${r}" fill="${color}"/>`);
    const k = (s * 0.52) / 24;
    out.push(`<g transform="translate(${x - 12 * k},${y - 12 * k}) scale(${k})" fill="none" stroke="${o.outline ? color : '#fff'}" stroke-width="${1.700}" stroke-linecap="round" stroke-linejoin="round">${I[icon]}</g>`);
    // the step's number, when the page beside the picture lists it
    if (o.n) { const bx = x - s / 2 + 3, by = y - s / 2 + 3; out.push(`<circle cx="${bx}" cy="${by}" r="11" fill="${C.bg}" stroke="${color}" stroke-width="2"/><text x="${bx}" y="${by + 4}" text-anchor="middle" class="k">${o.n}</text>`); }
    const ly = y + s / 2 + 24;
    out.push(`<text x="${x}" y="${ly}" text-anchor="middle" class="n">${esc(name)}</text>`);
    sub.forEach((t, i) => out.push(`<text x="${x}" y="${ly + 19 + i * 16}" text-anchor="middle" class="s">${esc(t)}</text>`));
    out.push(`</g>`);
  };
  const arrow = (d, o = {}) => out.push(`<path d="${d}" fill="none" stroke="${o.color ?? C.line}" stroke-width="${o.w ?? 2}" ${o.dash ? 'stroke-dasharray="6 6"' : ''} marker-end="url(#${o.color === C.skill ? 'as' : 'a'})"${o.both ? ` marker-start="url(#${o.color === C.skill ? 'bs' : 'b'})"` : ''}/>`);
  const note = (x, y, lines, o = {}) => lines.forEach((t, i) => out.push(`<text x="${x}" y="${y + i * 16}" text-anchor="${o.anchor ?? 'middle'}" class="${o.cls ?? 's'}"${o.color ? ` style="fill:${o.color}"` : ''}>${esc(t)}</text>`));
  const finish = (file, title, desc) => {
    const marker = (id, color, start) => `<marker id="${id}" viewBox="0 0 10 10" refX="${start ? 1 : 9}" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="${start ? 'M10 0 0 5l10 5z' : 'M0 0l10 5-10 5z'}" fill="${color}"/></marker>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<defs>${marker('a', C.line)}${marker('b', C.line, true)}${marker('as', C.skill)}${marker('bs', C.skill, true)}
<style>text{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:${C.text}}.h{font-size:30px;font-weight:700}.n{font-size:16px;font-weight:650}.t{font-size:13px;font-weight:600}.k{font-size:12px;font-weight:700}.s{font-size:13px;fill:${C.muted}}.b{font-size:12px;font-weight:700;letter-spacing:.09em;fill:${C.muted}}</style></defs>
${out.join('\n')}
</svg>
`;
    // number literals may carry trailing zeros; strip them for a clean file
    writeFileSync(file, svg.replace(/(\d)\.(\d*?)0+(?=[^\d])/g, (m, a, b) => (b ? `${a}.${b}` : a)));
    console.log('wrote', file, svg.length);
  };
  return { out, esc, tile, arrow, note, finish };
}
