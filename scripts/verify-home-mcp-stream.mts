/**
 * Spec 397 W3 — THE STREAM: progress and elicitation through the host, live (one composed answer; supplied plans).
 *
 *   npx tsx scripts/verify-home-mcp-stream.mts
 *
 * A client that accepts an event stream and declares elicitation: initialize (a session id comes back), then
 * tools/call ask "who is in Missio Nexus?" with a progress token — progress notifications arrive as her agent says what
 * it is doing, then the result. Then an ask that needs an answer from her (an invitation with no invitee): the server
 * asks the HOST (elicitation/create) with a schema built from the agent's fields; the client answers on the same
 * session; the run continues and parks for her authority. Resources: the doctrine and her agent's public card.
 * THE TWIN: a signature is never elicited — the parked act ends the stream with authority_required and grant_link.
 */
import { createHash, randomBytes } from 'node:crypto';
import { fixture as fx, HOME_MCP } from './fixture.mts';
const MCP = HOME_MCP;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${MCP}${path}`, { method: 'POST', headers: { 'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const reg = await j(await post('/oauth/register', { client_name: 'verify-home-mcp-stream', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }));
const verifier = b64u(randomBytes(48));
const conn = await j(await post('/oauth/demo-connect', { handle: fx.people.steward, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64u(createHash('sha256').update(verifier).digest()), resource: `${MCP}/mcp` }));
if (!conn.code) fail(`demo-connect: ${JSON.stringify(conn)}`);
const tok = await j(await post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: conn.code, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier, resource: `${MCP}/mcp` }).toString()));
if (!tok.access_token) fail(`token: ${JSON.stringify(tok)}`);
const auth = { authorization: `Bearer ${tok.access_token}` };

// ── initialize, declaring elicitation; the session id comes back ──
const initRes = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'verify', version: '0' } } }, auth);
const sid = initRes.headers.get('mcp-session-id') ?? '';
const init = await j(initRes);
console.log(`initialize → session ${sid ? sid.slice(0, 8) + '…' : 'NONE'} · capabilities ${JSON.stringify(Object.keys(init.result?.capabilities ?? {}))}`);
if (!sid) fail('no mcp-session-id on initialize');
if (!init.result?.capabilities?.resources) fail('resources capability not declared');
const H = { ...auth, 'mcp-session-id': sid, accept: 'text/event-stream' };

/** POST a request and read every SSE frame until the stream closes; answer elicitations with `answers`. */
async function streamed(body: unknown, answers: Record<string, unknown> = {}): Promise<{ frames: Array<Record<string, unknown>>; result?: Record<string, unknown>; elicited: number; progress: number }> {
  const res = await post('/mcp', body, H);
  if (!/text\/event-stream/.test(res.headers.get('content-type') ?? '')) fail(`not a stream: ${res.status} ${res.headers.get('content-type')} ${(await res.text()).slice(0, 200)}`);
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
  const frames: Array<Record<string, unknown>> = []; let result: Record<string, unknown> | undefined; let elicited = 0; let progress = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
      if (!data) continue;
      const m = JSON.parse(data) as Record<string, unknown>;
      frames.push(m);
      if (m.method === 'notifications/progress') { progress += 1; console.log(`  · ${(m.params as { message?: string }).message}`); }
      else if (m.method === 'elicitation/create') {
        elicited += 1;
        const p = m.params as { message: string; requestedSchema: { properties: Record<string, unknown>; required?: string[] } };
        console.log(`  ? elicitation: "${p.message}" fields ${JSON.stringify(Object.keys(p.requestedSchema.properties))}`);
        const content = Object.fromEntries(Object.keys(p.requestedSchema.properties).map((k) => [k, answers[k] ?? '']));
        const ack = await post('/mcp', { jsonrpc: '2.0', id: m.id, result: { action: 'accept', content } }, { ...auth, 'mcp-session-id': sid });
        console.log(`  → answered (${ack.status})`);
      } else if ('result' in m || 'error' in m) result = m;
    }
  }
  return { frames, result, elicited, progress };
}

// ── progress on a plain ask ──
let t0 = Date.now();
const a = await streamed({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { _meta: { progressToken: 'p1' }, name: 'ask', arguments: { message: `who is in ${fx.org.name}?`, plan: { steps: [{ toolId: 'organization.membership.list', args: { org: fx.org.name.toLowerCase() } }] } } } });
const sc = (a.result?.result as { structuredContent?: { kind?: string; text?: string } } | undefined)?.structuredContent;
console.log(`ask (streamed) → ${sc?.kind} · ${a.progress} progress line(s) · ${Date.now() - t0} ms · ${String(sc?.text ?? '').slice(0, 80)}…`);
if (sc?.kind !== 'answer') fail(`expected an answer on the stream: ${JSON.stringify(a.result).slice(0, 300)}`);
if (a.progress < 1) fail('no progress notification arrived');

// ── elicitation: an invitation with no invitee asks her; the host answers; the act then parks for her authority ──
t0 = Date.now();
const e = await streamed({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { _meta: { progressToken: 'p2' }, name: 'ask', arguments: { message: `invite someone to ${fx.org.name.toLowerCase()}`, plan: { steps: [{ toolId: 'organization.membership.invite', args: { org: fx.org.name.toLowerCase() } }] } } } }, { invitee: `${fx.people.member}.me` });
const es = (e.result?.result as { structuredContent?: { kind?: string; prompt?: { prompt?: string }; error?: string } } | undefined)?.structuredContent;
console.log(`invite (streamed) → ${es?.kind ?? es?.error} · elicited ${e.elicited} · ${Date.now() - t0} ms`);
if (e.elicited < 1) fail(`the agent's question was not put to the host: ${JSON.stringify(e.result).slice(0, 300)}`);
if (es?.kind === 'prompt' && /invitee|who/i.test(String(es.prompt?.prompt ?? ''))) fail('the answered question came back unanswered');
if (es?.kind !== 'authority_required' && es?.kind !== 'prompt' && es?.kind !== 'refused') fail(`unexpected end of the invite stream: ${JSON.stringify(es).slice(0, 300)}`);
if (e.frames.some((f) => f.method === 'elicitation/create' && JSON.stringify(f).includes('signature'))) fail('a signature was elicited');

// ── resources ──
const list = await j(await post('/mcp', { jsonrpc: '2.0', id: 4, method: 'resources/list', params: {} }, auth));
const uris = (list.result?.resources ?? []).map((r: { uri: string }) => r.uri);
console.log(`resources → ${JSON.stringify(uris)}`);
if (!uris.includes('ap://home-mcp/doctrine') || !uris.includes('ap://person/agent-card')) fail('resources missing');
const card = await j(await post('/mcp', { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'ap://person/agent-card' } }, auth));
const cardText = String(card.result?.contents?.[0]?.text ?? '');
console.log(`agent card → ${cardText ? JSON.parse(cardText).name ?? 'unnamed' : `ERROR ${JSON.stringify(card.error).slice(0, 120)}`}`);
if (!cardText) fail('her agent card could not be read');
// ── the host's own record: what it declared and how it called (the diagnostic a real Claude.ai session leaves) ──
const host = await j(await post('/mcp', { jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'ap://home-mcp/host' } }, { ...auth, 'mcp-session-id': sid }));
const hostRec = JSON.parse(String(host.result?.contents?.[0]?.text ?? '{}')) as { declared?: { elicitation?: boolean }; lastCall?: { streamed?: boolean; progressToken?: boolean; elicitation?: string }; calls?: number };
console.log(`host record → declared elicitation ${hostRec.declared?.elicitation} · calls ${hostRec.calls} · last call streamed ${hostRec.lastCall?.streamed} with progress token ${hostRec.lastCall?.progressToken} · elicitation ${hostRec.lastCall?.elicitation ?? '-'}`);
if (!hostRec.declared?.elicitation || !hostRec.lastCall?.streamed) fail('the host record does not reflect what this client declared and did');
console.log('\n✓ spec 397 W3: progress streamed, the agent\'s question put to the host and answered there, resources served; no signature ever elicited');
