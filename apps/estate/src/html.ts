// The page shell. Server-rendered once; `/app.js` fills the live figures from `/api/heartbeat` and handles sign-in.
// Every value that reaches markup is escaped — the estate's name is configuration, but nothing is trusted to be inert.
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface PageInput { id: string; name: string; home: string; view: 'overview' | 'waiting' }

export function page(p: PageInput): string {
  const nav = (href: string, label: string, on: boolean): string => `<a href="${href}"${on ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.name)}</title>
<meta name="description" content="${esc(p.name)} — the estate's own page: how it is doing, and what is waiting on a steward.">
<link rel="stylesheet" href="/style.css">
</head><body data-estate="${esc(p.id)}" data-home="${esc(p.home)}" data-view="${p.view}">
<header class="top"><a class="brand" href="/">${esc(p.name)}</a>
<nav>${nav('/', 'Overview', p.view === 'overview')}${nav('/waiting', 'Waiting on me', p.view === 'waiting')}</nav>
<span id="who" class="who"></span></header>
<main id="main"><p class="quiet">Reading the estate…</p></main>
<script type="module" src="/app.js"></script>
</body></html>`;
}
