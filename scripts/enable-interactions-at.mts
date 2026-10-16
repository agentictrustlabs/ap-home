/**
 * ENABLE AN AGENT'S INTERACTIONS ON A DEPLOYMENT — the grant projection its serving plane needs.
 *
 *   A2A_URL=https://a2a-b.faithnet.io npx tsx scripts/enable-interactions-at.mts <steward-handle> [org-name]
 *
 * The interactions grant (principal → the interactions service agent, one year) is the vault's record; a
 * deployment's InteractionsDO holds a projection of it, and a SECOND deployment starts with none. This
 * issues it there the way the Home does — the steward's custodian signs (the org validates ERC-1271) and
 * ONE post lands it — without an org name it enables the steward's own agent.
 */
import { buildInteractionsGrantForScript, issueInboxDeliveryDelegation, toWire } from '../apps/home/src/lib/delegation';
import { MCP_SERVER_ID } from '../apps/home/src/lib/inbox-delivery';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const A2A = (process.env.A2A_URL ?? 'https://a2a.faithnet.io').replace(/\/$/, '');
const [handle, orgName] = process.argv.slice(2);
if (!handle) throw new Error('usage: A2A_URL=… enable-interactions-at.mts <steward-handle> [org-name]');
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };

const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
if (!si.homeSession) throw new Error(`no session for ${handle}`);
let principal = String(si.agent).toLowerCase();
if (orgName) {
  const orgs = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${si.homeSession}` } }))).orgs ?? []) as Array<{ orgAgent: string; orgName: string; relationship: string }>;
  // By name, or by address (an organization whose name is deferred — spec 444: imbnet's org on hopechain — has none yet).
  const org = orgs.find((o) => (o.orgName.toLowerCase() === orgName.toLowerCase() || o.orgAgent.toLowerCase() === orgName.toLowerCase()) && o.relationship === 'steward');
  if (!org) throw new Error(`${handle} does not steward ${orgName}`);
  principal = org.orgAgent.toLowerCase();
}
const sign = async (digest: `0x${string}`): Promise<string> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`); return b.signature; };
const { grant, sessionLeaf } = await buildInteractionsGrantForScript(principal, sign, async (path) => j(await fetch(`${A2A}${path}`)));
const csrfRes = await fetch(`${A2A}/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
const res = await j(await fetch(`${A2A}/interactions/${principal}/grant`, { method: 'POST', headers: H, body: JSON.stringify({ delegation: grant, ...(sessionLeaf ? { sessionLeaf } : {}) }) }));
const status = await j(await fetch(`${A2A}/interactions/${principal}/status`, { method: 'POST', headers: H, body: JSON.stringify({ session: si.homeSession }) }));
console.log(`${orgName ?? handle} ${principal} at ${A2A}: grant=${JSON.stringify(res).slice(0, 160)} current=${status.current ?? JSON.stringify(status).slice(0, 120)}`);
if (res.ok !== true) process.exit(1);
// THE DELIVERY PLANE (spec 323 W3) — the write-only wire that lets a sender's delivery land in this agent's inbox. Without it
// the recipient's DO answers 409 to the body write and the message is lost from the sender's queue, though the sender's
// own send reported "delivered" (an imbnet invitation to hannah, 2026-10-16). The delegate is the deployment's delivery
// service agent (DELIVERY_SA; the interactions service agent where the runtime pins none).
const DELIVERY_SA = (process.env.DELIVERY_SA ?? process.env.NEXT_PUBLIC_INTERACTIONS_SERVICE_SA ?? '') as `0x${string}`;
if (!/^0x[0-9a-fA-F]{40}$/.test(DELIVERY_SA)) throw new Error('DELIVERY_SA (or NEXT_PUBLIC_INTERACTIONS_SERVICE_SA) required for the delivery plane');
const dd = await issueInboxDeliveryDelegation(principal as `0x${string}`, DELIVERY_SA, MCP_SERVER_ID, sign as never);
const dres = await j(await fetch(`${A2A}/interactions/${principal}/grant.delivery.put`, { method: 'POST', headers: H, body: JSON.stringify({ delegation: toWire(dd) }) }));
const after = await j(await fetch(`${A2A}/interactions/${principal}/status`));
console.log(`  delivery plane: ${JSON.stringify(dres).slice(0, 160)} deliveryGranted=${after.deliveryGranted}`);
if (after.deliveryGranted !== true) process.exit(1);
