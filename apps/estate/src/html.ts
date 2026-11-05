// The page shell. Server-rendered once; `/app.js` fills the live figures from `/api/heartbeat` and handles sign-in.
// Every value that reaches markup is escaped — the estate's name is configuration, but nothing is trusted to be inert.
//
// WHO SEES WHAT. A session is held by the visitor's own tab (sessionStorage), so this Worker never knows whether a visitor is
// signed in. The markup therefore carries both faces and `/nav.js` (first thing in the head, before anything paints) marks the
// document `data-connected` when the tab holds a session. Without that mark the steward's menu (`data-auth`) is not shown and the
// front page is the cover; with it the menu shows and the cover does not. The architecture link and posts are for everyone.
// Hiding the menu is presentation, not protection: what a session may read or do is the estate runtime's answer on every call.
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Current = 'overview' | 'waiting' | 'architecture' | null;
const header = (name: string, current: Current, who: boolean): string => {
  const nav = (href: string, label: string, on: boolean, auth: boolean): string => `<a href="${href}"${auth ? ' data-auth' : ''}${on ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<header class="top"><a class="brand" href="/">${esc(name)}</a>
<nav>${nav('/', 'Overview', current === 'overview', true)}${nav('/waiting', 'Waiting on me', current === 'waiting', true)}${nav('/architecture', 'Architecture', current === 'architecture', false)}</nav>${who ? '\n<span id="who" class="who"></span>' : ''}</header>`;
};

/** `connecting` is the Home's redirect back (`/connected`): no cover, only the sign-in finishing. `cards` is trusted markup
 *  written in this repository: the architecture posts, shown under the cover. */
export interface PageInput { id: string; name: string; home: string; view: 'overview' | 'waiting' | 'connecting'; cards: string }

export function page(p: PageInput): string {
  const connecting = p.view === 'connecting';
  const cover = connecting ? '' : `
<div class="cover"><div class="cover-in">
<div>
<p class="eyebrow">An estate of agents</p>
<h1>${esc(p.name)}</h1>
<p class="tag">People, organizations and services, each with an agent of their own: an identity that can sign, authority checked when it acts, and evidence its owner keeps.</p>
<p class="actions"><button class="primary" data-signin>Sign in at your Home</button><a class="btn ghost" href="/architecture">Read how it works</a></p>
<p class="fine">Stewards sign in to see how the estate is doing and what is waiting on them. Signing in happens at your Home, never here.</p>
</div>
<img class="cover-art" src="/cover.svg" alt="" width="600" height="460">
</div></div>
<section class="cover-posts"><h2>How this estate works</h2>
<div class="cards">${p.cards}</div>
<p><a href="/architecture">All architecture posts →</a></p></section>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.name)}</title>
<meta name="description" content="${esc(p.name)}: an estate of agents. Stewards sign in to see how it is doing; anyone can read how it works.">
<script src="/nav.js"></script>
<link rel="stylesheet" href="/style.css">
</head><body data-estate="${esc(p.id)}" data-home="${esc(p.home)}" data-view="${p.view}">
${header(p.name, p.view === 'connecting' ? null : p.view, true)}${cover}
<main id="main"${connecting ? '' : ' hidden'}><p class="quiet">${connecting ? 'Finishing your sign-in…' : 'Reading the estate…'}</p></main>
<script type="module" src="/app.js"></script>
</body></html>`;
}

/** A STATIC page under the estate's header: prose and pictures authored in this repository (the architecture posts). It reads
 *  nothing live; its one script is `/nav.js`. `main` is trusted markup written here; every other value is escaped. */
export interface ShellInput { name: string; current: 'architecture'; title: string; description: string; canonical: string; image?: string; article?: boolean; main: string }

export function shell(p: ShellInput): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}">
<link rel="canonical" href="${esc(p.canonical)}">
<meta property="og:type" content="${p.article ? 'article' : 'website'}">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${esc(p.canonical)}">
${p.image ? `<meta property="og:image" content="${esc(p.image)}">\n<meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
<script src="/nav.js"></script>
<link rel="stylesheet" href="/style.css">
</head><body>
${header(p.name, p.current, false)}
<main>${p.main}</main>
</body></html>`;
}
