import { describe, expect, it, vi } from 'vitest';
import worker, { readHeartbeat, relay, type Env } from '../src/index.js';
import { POSTS } from '../src/architecture.js';

const env = { ASSETS: { fetch: async () => new Response('asset') }, ESTATE_ID: 'faithnet', ESTATE_NAME: 'faithnet.estate', HOME_ORIGIN: 'https://www.faithnet.me', A2A_ORIGIN: 'https://a2a.test', PUBLIC_ORIGIN: 'https://faithnet.estate' } as unknown as Env;
const post = (path: string, origin: string | null, body = '{}') => new Request(`https://faithnet.estate${path}`, { method: 'POST', headers: origin ? { origin } : {}, body });

describe('heartbeat', () => {
  it('says so when no token is held, rather than reading zeros', async () => {
    const r = await readHeartbeat(env);
    expect(r).toMatchObject({ ok: false, status: 503 });
  });
  it('refuses an answer that is not a heartbeat', async () => {
    const r = await readHeartbeat({ ...env, ESTATE_HEARTBEAT_TOKEN: 't' }, (async () => new Response(JSON.stringify({ hello: 1 }))) as typeof fetch);
    expect(r).toMatchObject({ ok: false, status: 502 });
  });
});

describe('relay', () => {
  it('mints a CSRF token as this site and sends it as header and cookie', async () => {
    const f = vi.fn(async (u: RequestInfo | URL) => String(u).endsWith('/auth/csrf') ? new Response(JSON.stringify({ ok: true, token: 'tok' })) : new Response('{"ok":true}'));
    const res = await relay(env, 'runs', '{"a":1}', f as unknown as typeof fetch);
    expect(res.status).toBe(200);
    const [, init] = f.mock.calls[1]! as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'x-csrf-token': 'tok', cookie: 'agentic-csrf=tok', origin: 'https://faithnet.estate' });
  });
  it('names the allowlist when the runtime will not issue a token', async () => {
    const res = await relay(env, 'runs', '{}', (async () => new Response('{}', { status: 400 })) as typeof fetch);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('ALLOWED_ORIGINS');
  });
});

describe('the manage door', () => {
  it('relays only the three harness calls', async () => {
    expect((await worker.fetch(post('/api/manage/grant', 'https://faithnet.estate'), env)).status).toBe(404);
  });
  it('answers its own page only', async () => {
    expect((await worker.fetch(post('/api/manage/runs', 'https://evil.example'), env)).status).toBe(403);
    expect((await worker.fetch(post('/api/manage/runs', null), env)).status).toBe(403);
  });
});

describe('the architecture posts', () => {
  const get = (path: string) => worker.fetch(new Request(`https://faithnet.estate${path}`), env);
  it('lists the posts and links each one', async () => {
    const res = await get('/architecture');
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const post of POSTS) expect(html).toContain(`href="/architecture/${post.slug}"`);
    expect(html).toContain('aria-current="page">Architecture</a>');
    expect(html.match(/<script[^>]*>/g)).toEqual(['<script src="/nav.js">']);
  });
  it('serves a post with its picture, described for a reader who cannot see it, and a link preview', async () => {
    const html = await (await get('/architecture/agent-harness')).text();
    expect(html).toContain('<h1>How an ask runs at an agent</h1>');
    expect(html).toMatch(/<img src="\/architecture\/agent-harness-flow\.svg" alt="A flow diagram\.[^"]{200,}"/);
    expect(html).toContain('<meta property="og:image" content="https://faithnet.estate/architecture/agent-harness-flow.png">');
    expect(html).toContain('<link rel="canonical" href="https://faithnet.estate/architecture/agent-harness">');
  });
  it('lists a flow post\'s steps beside its picture, each one opening its details with no script of its own', async () => {
    for (const post of POSTS) {
      if (!post.steps) continue;
      const html = await (await get(`/architecture/${post.slug}`)).text();
      expect(html.match(/<script[^>]*>/g)).toEqual(['<script src="/nav.js">']);
      expect(html).toContain('<i id="closed"></i>');
      expect(post.steps.length).toBeGreaterThan(0);
      expect(post.steps.length).toBeLessThanOrEqual(12); // style.css marks the open step for up to twelve
      expect(new Set(post.steps.map((s) => s.id)).size).toBe(post.steps.length);
      for (const step of post.steps) {
        // in the list, on its tile in the picture, and as a panel that says why the step exists and where it runs
        expect(html.split(`href="#step-${step.id}"`).length - 1).toBeGreaterThanOrEqual(2);
        const panel = html.slice(html.indexOf(`<aside class="fly" id="step-${step.id}"`)).split('</aside>')[0]!;
        for (const heading of ['Why this step exists', 'What happens', 'Where it runs', post.byHeading ?? 'A model, or code', 'What it reads', 'What it leaves behind', 'How it stops or holds']) expect(panel).toContain(`<h3>${heading}</h3>`);
        expect(panel).toContain(step.why);
        // the tile is inside the picture
        expect(step.at[0]).toBeLessThan(post.picture.width);
        expect(step.at[1]).toBeLessThan(post.picture.height);
      }
    }
  });
  it('serves an article: prose under its picture, with no steps', async () => {
    const html = await (await get('/architecture/harness-needs-substrate')).text();
    expect(html).toContain('<h1>Great Agent Harness requires Agentic Primitives Substrate</h1>');
    expect(html).toContain('<meta property="og:image" content="https://faithnet.estate/architecture/harness-on-substrate.png">');
    expect(html).toContain('href="/architecture/agent-harness"');
    expect(html).not.toContain('class="flow"');
  });
  it('asks who acts at a step of a flow with no model, and a model or code at the harness', async () => {
    const signIn = await (await get('/architecture/sign-in')).text();
    expect(signIn).toContain('<h1>How sign-in works: the first time, a new app, and coming back</h1>');
    expect(signIn).toContain('<h3>Who acts</h3>');
    expect(signIn).not.toContain('<h3>A model, or code</h3>');
    expect(signIn).toContain('id="step-allow"');
    const harness = await (await get('/architecture/agent-harness')).text();
    expect(harness).toContain('<h3>A model, or code</h3>');
    expect(harness).not.toContain('<h3>Who acts</h3>');
  });
  it('leaves a picture and an unknown post to the assets (a 404 there, never an empty page here)', async () => {
    expect(await (await get('/architecture/agent-harness-flow.svg')).text()).toBe('asset');
    expect(await (await get('/architecture/no-such-post')).text()).toBe('asset');
  });
});

describe('a Home\'s sign-out', () => {
  it('passes through a page of this site, which names the Home it may return to', async () => {
    const res = await worker.fetch(new Request('https://faithnet.estate/sso-logout?return=x'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('<script src="/sso-logout.js" data-home="https://www.faithnet.me">');
  });
});

describe('who sees what', () => {
  const get = async (path: string) => (await worker.fetch(new Request(`https://faithnet.estate${path}`), env)).text();
  const links = (html: string) => [...html.slice(html.indexOf('<nav>'), html.indexOf('</nav>')).matchAll(/<a href="([^"]+)"( data-auth)?/g)].map((m) => `${m[1]}${m[2] ? ' (signed in)' : ''}`);
  it('marks the steward\'s menu for a signed-in tab only, and leaves Architecture to everyone, on every page', async () => {
    for (const path of ['/', '/waiting', '/connected', '/architecture', '/architecture/agent-harness']) {
      const html = await get(path);
      expect(links(html)).toEqual(['/ (signed in)', '/waiting (signed in)', '/architecture']);
      // the mark is made before anything paints
      expect(html.indexOf('<script src="/nav.js"></script>')).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
    }
  });
  it('gives a visitor the cover, with a way in and the posts to read, and holds the estate\'s own page back', async () => {
    for (const path of ['/', '/waiting']) {
      const html = await get(path);
      expect(html).toContain('<div class="cover">');
      expect(html).toContain('<button class="primary" data-signin>Sign in at your Home</button>');
      for (const post of POSTS.slice(0, 3)) expect(html).toContain(`href="/architecture/${post.slug}"`);
      expect(html).toContain('<main id="main" hidden>');
    }
  });
  it('shows no cover while a sign-in is finishing', async () => {
    const html = await get('/connected');
    expect(html).not.toContain('class="cover"');
    expect(html).toContain('<main id="main">');
  });
});
