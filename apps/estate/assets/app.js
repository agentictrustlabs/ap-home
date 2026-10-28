// The estate page's client. Vanilla, no build: every string goes in through textContent, never markup.
// Sign-in is the Home's own OAuth leg (PKCE S256) as `estate-app`, asking for `site-login` — who you are, no
// authority to act. The session lives in THIS TAB's sessionStorage only. Whether the session may do a thing is
// the estate runtime's answer, asked on every call; nothing here decides it.
const KEY = 'estate.home-session', PENDING = 'estate.connecting', CLIENT_ID = 'estate-app';
const body = document.body, main = document.getElementById('main'), who = document.getElementById('who');
const home = body.dataset.home, view = body.dataset.view;

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const c of kids.flat()) if (c !== null && c !== undefined) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const show = (...kids) => main.replaceChildren(...kids);
const read = () => { try { const c = JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); return c?.token ? c : null; } catch { return null; } };
const write = (c) => { try { c ? sessionStorage.setItem(KEY, JSON.stringify(c)) : sessionStorage.removeItem(KEY); } catch { /* no storage: unconnected */ } };
const b64url = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const claims = (jwt) => { try { return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; } };

async function signIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = crypto.randomUUID();
  try { sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state })); sessionStorage.setItem('estate.return-to', location.pathname); } catch { /* the callback says so */ }
  const u = new URL('/', home);
  for (const [k, v] of Object.entries({ client_id: CLIENT_ID, redirect_uri: `${location.origin}/connected`, response_type: 'code', scope: 'openid agent', code_challenge: challenge, code_challenge_method: 'S256', state, delegation_template: 'site-login' })) u.searchParams.set(k, v);
  location.assign(u.toString());
}

async function finishSignIn() {
  const q = new URLSearchParams(location.search);
  let pending = null; try { pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null'); sessionStorage.removeItem(PENDING); } catch { /* none */ }
  const fail = (m) => show(h('p', { class: 'err' }, m), h('p', {}, h('a', { href: '/' }, 'Back to the estate')));
  if (q.get('error')) return fail(q.get('error_description') ?? q.get('error'));
  if (!q.get('code')) return fail('Your Home sent no code back.');
  if (!pending) return fail('This tab did not start that sign-in, so it cannot finish it.');
  if (q.get('state') !== pending.state) return fail('That sign-in does not match the one this tab started.');
  try {
    const r = await fetch(new URL('/token', home), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code: q.get('code'), code_verifier: pending.verifier, client_id: CLIENT_ID, redirect_uri: `${location.origin}/connected` }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok || !b.id_token) return fail(b.error_description ?? b.error ?? `Your Home refused the exchange (${r.status}).`);
    const c = claims(b.id_token);
    write({ token: b.id_token, name: c.name ?? null, agent: c.agent ?? null });
  } catch (e) { return fail(`Your Home could not be reached: ${e.message}`); }
  let back = '/'; try { back = sessionStorage.getItem('estate.return-to') || '/'; sessionStorage.removeItem('estate.return-to'); } catch { /* the front page */ }
  location.replace(back.startsWith('/') && !back.startsWith('//') ? back : '/');
}

function renderWho() {
  const c = read();
  who.replaceChildren(...(c
    ? [c.name ?? 'signed in', ' · ', h('button', { onclick: () => { write(null); location.reload(); } }, 'Sign out')]
    : [h('button', { class: 'primary', onclick: () => void signIn() }, 'Sign in at your Home')]));
}

const manage = async (op, payload) => {
  const r = await fetch(`/api/manage/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
};

async function overview() {
  const [est, hb] = await Promise.all([
    fetch('/api/estate').then((r) => r.json()),
    fetch('/api/heartbeat').then((r) => r.json().catch(() => ({ ok: false, error: 'unreadable' }))),
  ]);
  const facts = [['Estate name on chain', est.name], ['Home', est.home], ['Runtime', est.a2a]];
  if (est.ask) facts.push(['Answers the Ask', est.ask.name], ...(est.ask.card ? [['Agent card', h('a', { href: est.ask.card }, est.ask.card)]] : []));
  const tiles = hb.ok
    ? h('div', { class: 'grid' }, hb.tiles.map((t) => h('div', { class: `tile ${t.tone ?? ''}` }, h('div', { class: 'l' }, t.label), h('div', { class: 'v' }, t.value), t.sub ? h('div', { class: 's' }, t.sub) : null)))
    // NOT READING IS NOT ZERO: say why, and show no figures.
    : h('p', { class: 'note' }, `The estate's heartbeat could not be read: ${hb.error}`);
  show(
    h('h1', {}, est.name),
    h('p', { class: 'quiet' }, hb.ok ? `live · ${hb.ago}${hb.stale ? ' · STALE' : ''} · generation ${hb.generation}` : 'not reading'),
    tiles,
    h('h2', {}, 'This estate'),
    h('dl', { class: 'facts' }, facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    h('p', {}, h('a', { href: '/waiting' }, 'Runs waiting on you →')),
  );
}

async function waiting() {
  const c = read();
  if (!c) return show(h('h1', {}, 'Waiting on me'), h('p', {}, 'Sign in at your Home to see the runs that are waiting on your signature.'), h('button', { class: 'primary', onclick: () => void signIn() }, 'Sign in at your Home'));
  if (!c.agent) return show(h('h1', {}, 'Waiting on me'), h('p', { class: 'err' }, 'Your session names no agent, so there is nothing to read.'));
  show(h('h1', {}, 'Waiting on me'), h('p', { class: 'quiet' }, 'Reading your agent…'));
  const out = await manage('runs', { session: c.token, addressee: c.agent });
  if (!out.ok) return show(h('h1', {}, 'Waiting on me'), h('p', { class: 'err' }, out.error ?? 'The runtime did not answer.'));
  const rows = (out.runs ?? []).map((r) => {
    const msg = h('span', { class: 'err' });
    const cancel = h('button', { onclick: async () => {
      cancel.disabled = true; msg.textContent = '';
      const res = await manage('cancel', { session: c.token, addressee: c.agent, runRef: r.runRef });
      if (res.ok) row.remove(); else { cancel.disabled = false; msg.textContent = res.error ?? 'Could not stop it.'; }
    } }, 'Stop this run');
    const row = h('div', { class: 'row' }, h('div', {}, r.message), r.awaiting ? h('div', { class: 'quiet' }, `Waiting for: ${r.awaiting.prompt}`) : null, h('div', {}, cancel, ' ', msg));
    return row;
  });
  show(h('h1', {}, 'Waiting on me'), rows.length ? rows : h('p', { class: 'quiet' }, 'Nothing is waiting on you.'),
    h('p', { class: 'quiet' }, 'To approve a signature, open it at your Home — a signature is made with your own passkey, never here.'),
    h('p', {}, h('a', { href: home }, 'Open your Home →')));
}

renderWho();
(location.pathname === '/connected' ? finishSignIn() : view === 'waiting' ? waiting() : overview())
  .catch((e) => show(h('p', { class: 'err' }, `Something failed: ${e.message}`)));
