// OPERATOR SURFACE (spec 397 §11.1 / §11.4) — the two things a client that is not Claude needs from this Worker's
// operator, and nothing else:
//
//   1. ALLOW A REGISTRATION FOR SCOPE `act`. A host that registers itself (RFC 7591) cannot present the operator's
//      secret from inside its own flow — Meta Muse builds its connector on its own VM and registers from there. So the
//      operator lists the registrations this Worker holds, sees the one the host made (by name, redirect and time),
//      and flags it. The flag is the ONLY way a dynamic registration ever gets `act`; nothing in the registration
//      body can set it (`clientMayAct`).
//   2. A CONNECTION KEY. A host that cannot finish an OAuth code exchange (Muse's custom-connector path asks for "an
//      API key or a header" when it cannot) gets a bearer the PERSON mints at this Worker in her own browser: the
//      same authorization flow, the Worker as its own curated client, a long-lived access token shown once. It is a
//      bearer for THIS resource and nothing else — her agent still verifies her wire on every call, so revoking the
//      wire at her Home ends the key (verify-home-mcp-revoke), and `/oauth/revoke` ends it too.
//
// Both are guarded by `ACT_REGISTRATION_SECRET` (the operator's) or by the person's own browser session with the Home.
import type { ClientRow, Store } from './store.js';

export const KEY_CLIENT_ID = 'home-mcp-key' as const;
/** A connection key lives as long as the ask-as-me wire it rides on (30 days); the wire's revocation ends it sooner. */
export const KEY_ACCESS_TTL_SECONDS = 30 * 86_400;

export function operatorAllowed(env: { ACT_REGISTRATION_SECRET?: string }, presented: string | undefined): boolean {
  const secret = (env.ACT_REGISTRATION_SECRET ?? '').trim();
  return !!secret && !!presented && presented.trim() === secret;
}

/** Registrations as the operator sees them: never a secret hash. */
export function clientView(r: ClientRow): { client_id: string; client_name: string | null; redirect_uris: string[]; created_at: string; act: boolean; auth: string } {
  return { client_id: r.client_id, client_name: r.client_name ?? null, redirect_uris: r.redirect_uris, created_at: new Date(r.created_at).toISOString(), act: r.act === true, auth: r.token_endpoint_auth_method };
}

export async function listClients(store: Store): Promise<ReturnType<typeof clientView>[]> {
  const rows = await store.listClients();
  return rows.sort((a, b) => b.created_at - a.created_at).map(clientView);
}

/** Flip scope-`act` permission on ONE registration. Refuses an id this Worker never registered. */
export async function setClientAct(store: Store, clientId: string, allow: boolean): Promise<{ ok: true; client: ReturnType<typeof clientView> } | { ok: false; error: string }> {
  const row = await store.getClient(clientId);
  if (!row) return { ok: false, error: `no registration ${clientId}` };
  const next: ClientRow = { ...row, act: allow };
  await store.putClient(next);
  return { ok: true, client: clientView(next) };
}

/** The Worker's OWN client for connection keys: curated (act allowed), public, redirecting to its own done page. */
export async function ensureKeyClient(store: Store, origin: string): Promise<ClientRow> {
  const redirect = `${origin}/connect/key/done`;
  const have = await store.getClient(KEY_CLIENT_ID);
  if (have && have.redirect_uris.includes(redirect) && have.act === true) return have;
  const row: ClientRow = { client_id: KEY_CLIENT_ID, client_name: 'Connection key (this Home MCP, in your browser)', redirect_uris: [...new Set([...(have?.redirect_uris ?? []), redirect])], token_endpoint_auth_method: 'none', created_at: have?.created_at ?? Date.now(), act: true };
  await store.putClient(row);
  return row;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));

const SHELL = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1f2937}h1{font-size:1.4rem}code,pre{font:13px/1.4 ui-monospace,monospace;background:#f3f4f6;border-radius:6px}code{padding:.1rem .3rem}pre{padding:.8rem;overflow:auto;white-space:pre-wrap;word-break:break-all}.btn{display:inline-block;background:#d97706;color:#fff;padding:.6rem 1rem;border-radius:8px;text-decoration:none;font-weight:600}.muted{color:#6b7280;font-size:.9rem}.warn{border-left:4px solid #d97706;padding:.4rem .8rem;background:#fffbeb}label{display:block;margin:.4rem 0}</style></head><body>${body}</body></html>`;

/** `/connect/key` — what a key is, what it is not, and one button per scope. */
export function keyStartPage(origin: string, homeOrigin: string): string {
  return SHELL('Connection key', `
<h1>A connection key for an assistant that cannot sign in with OAuth</h1>
<p>Some assistants (Meta Muse's custom connectors, for one) ask for "an API key or a header" instead of finishing a sign-in. This page makes one <b>in your browser, by the same ceremony as a sign-in</b>: you authorize at your Home, and the key you get is a bearer for <code>${esc(origin)}/mcp</code> and nothing else.</p>
<div class="warn"><p><b>What it is not.</b> Not a password, not a signature, not authority. Every call it makes still goes to your agent as <i>you</i> under the wire you sign at your Home; an act parks for your signature unless you pre-authorized it. Revoke the wire under Connected → Assistants at your Home and the key is dead everywhere.</p></div>
<form method="get" action="${esc(origin)}/connect/key/start">
<label><input type="radio" name="scope" value="ask" checked> <b>Ask only</b> — put questions to your agent as you; every act waits for your signature.</label>
<label><input type="radio" name="scope" value="ask act"> <b>Ask + the acts you check</b> — you will choose the acts and, for payments, the payee and the cap at your Home.</label>
<p><button class="btn" type="submit">Create a connection key</button></p>
</form>
<p class="muted">You will be sent to <code>${esc(homeOrigin)}</code> to authorize, then back here. The key is shown once and never stored in readable form by this service. Valid 30 days; the wire's expiry or revocation ends it sooner.</p>`);
}

/** `/connect/key/done` — the key, once, with the words an assistant needs. */
export function keyDonePage(origin: string, key: string, scope: string, expiresInSeconds: number): string {
  const days = Math.round(expiresInSeconds / 86_400);
  const paste = `Create a Custom Connector for a remote MCP server, then connect to it:
- Name: my-home
- Transport: remote streamable HTTP
- URL: ${origin}/mcp
- Auth: header  Authorization: Bearer <the key>  (paste the key through the secure credential prompt, never in the chat)
Then list its tools, call the "ask" tool with the message "what is waiting on me", show me the reply, and save the connection as a reusable skill.`;
  return SHELL('Your connection key', `
<h1>Your connection key</h1>
<p>Scope <code>${esc(scope)}</code> · valid ${days} days · bearer for <code>${esc(origin)}/mcp</code>. <b>Shown once.</b></p>
<pre id="key">${esc(key)}</pre>
<h2 style="font-size:1.1rem">Give it to the assistant</h2>
<p>Send the header <code>Authorization: Bearer &lt;key&gt;</code> on every <code>POST ${esc(origin)}/mcp</code>. For Meta Muse, paste this into a chat and give the key through its secure credential prompt when it asks:</p>
<pre>${esc(paste)}</pre>
<p class="muted">To end it: revoke the assistant under Connected → Assistants at your Home (the wire goes with it, on chain), or <code>POST ${esc(origin)}/oauth/revoke</code> with the key.</p>`);
}

export function keyErrorPage(origin: string, message: string): string {
  return SHELL('Connection key', `<h1>No key was made</h1><p>${esc(message)}</p><p><a class="btn" href="${esc(origin)}/connect/key">Try again</a></p>`);
}

/** The PKCE state carried across the Home round-trip in an HttpOnly cookie: `state.verifier`. */
export function keyCookie(value: string, maxAgeSeconds: number): string {
  return `hm_key=${value}; Path=/connect/key; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}
export function readKeyCookie(header: string | undefined): { state: string; verifier: string } | null {
  const m = /(?:^|;\s*)hm_key=([^;]+)/.exec(header ?? '');
  if (!m) return null;
  const [state, verifier] = m[1]!.split('.');
  return state && verifier ? { state, verifier } : null;
}
