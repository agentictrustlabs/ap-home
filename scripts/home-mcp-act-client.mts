/**
 * Spec 397 §11.1 — the operator's two verbs over a Home MCP's registrations, for a host that registers ITSELF
 * (Meta Muse's custom connector, any MCP host with dynamic registration) and so cannot present the act secret:
 *
 *   npx tsx scripts/home-mcp-act-client.mts list                 # every registration: id · name · redirect · when · act
 *   npx tsx scripts/home-mcp-act-client.mts allow <client_id>    # let this registration request scope `act`
 *   npx tsx scripts/home-mcp-act-client.mts deny  <client_id>    # take it back
 *
 * The secret comes from HOME_MCP_ACT_REGISTRATION_SECRET or ~/.agenticprimitives/home-mcp-act.env; the Worker from
 * HOME_MCP_URL (default: the fixture's). After `allow`, the host re-authorizes with scope `ask act` and the person
 * sees the act consent at her Home.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { HOME_MCP } from './fixture.mts';

function secret(): string {
  const fromEnv = process.env.HOME_MCP_ACT_REGISTRATION_SECRET?.trim();
  if (fromEnv) return fromEnv;
  try {
    const txt = readFileSync(`${homedir()}/.agenticprimitives/home-mcp-act.env`, 'utf8');
    const m = /^HOME_MCP_ACT_REGISTRATION_SECRET=(.+)$/m.exec(txt);
    if (m?.[1]) return m[1].trim();
  } catch { /* fall through */ }
  console.error('no act registration secret: set HOME_MCP_ACT_REGISTRATION_SECRET or write ~/.agenticprimitives/home-mcp-act.env');
  process.exit(2);
}
const H = { 'x-act-registration': secret(), 'content-type': 'application/json' };
const [verb, id] = process.argv.slice(2);
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };

if (verb === 'list') {
  const b = await j(await fetch(`${HOME_MCP}/oauth/clients`, { headers: H }));
  if (!b.ok) { console.error(JSON.stringify(b)); process.exit(1); }
  for (const c of b.clients as Array<{ client_id: string; client_name: string | null; redirect_uris: string[]; created_at: string; act: boolean }>) {
    console.log(`${c.act ? 'ACT ' : '    '}${c.client_id}  ${c.client_name ?? '(unnamed)'}  ${c.redirect_uris.join(' ')}  ${c.created_at}`);
  }
} else if ((verb === 'allow' || verb === 'deny') && id) {
  const b = await j(await fetch(`${HOME_MCP}/oauth/clients/${encodeURIComponent(id)}/act`, { method: 'POST', headers: H, body: JSON.stringify({ allow: verb === 'allow' }) }));
  if (!b.ok) { console.error(JSON.stringify(b)); process.exit(1); }
  console.log(`${b.client.client_id} (${b.client.client_name ?? 'unnamed'}): act ${b.client.act ? 'ALLOWED — it may now authorize with scope "ask act"' : 'denied'}`);
} else {
  console.error('usage: home-mcp-act-client.mts list | allow <client_id> | deny <client_id>');
  process.exit(2);
}
