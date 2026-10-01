/**
 * Spec 366 §6 — A PERSON'S AGENT ANSWERS ONLY ITS OWN PERSON (the Muse incident, 2026-10-01; no model: supplied plan).
 *
 *   npx tsx scripts/verify-person-agent-door.mts
 *
 * bob's agent `engage`s carol.me with "this is a direct message…" — the routed ask reaches carol's agent, which refuses
 * AT THE DOOR in its own words, names the right door (a message from bob's own agent), and runs no plan: nothing of
 * carol's is read for bob. Twin inside: the refusal text carries nothing from her records.
 */
import type { Address } from 'viem';
import { fixture as fx, HOME } from './fixture.mts';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
function fail(m: string): never { console.error(`\n✗ ${m}`); process.exit(1); }
interface Session { token: string; agent: Address; handle: string; csrf: string; cookie: string }
async function open(handle: string): Promise<Session> {
  const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
  if (!si.homeSession) fail(`demo-signin ${handle}: ${JSON.stringify(si).slice(0, 200)}`);
  const cr = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME, 'user-agent': UA } });
  const csrf = ((await j(cr)) as { token?: string }).token ?? '';
  const cookie = (cr.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return { token: si.homeSession, agent: String(si.agent).toLowerCase() as Address, handle, csrf, cookie };
}
const call = async (s: Session, path: string, body: Record<string, unknown>) => j(await fetch(`${HOME}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie: s.cookie, 'x-csrf-token': s.csrf, 'user-agent': UA }, body: JSON.stringify({ session: s.token, addressee: s.agent, ...body }) }));
type Rec = { runRef: string; at: number; plan?: { steps?: Array<{ toolId: string }> }; door?: { kind?: string } };
const records = async (s: Session): Promise<Rec[]> => ((await call(s, '/a2a/harness/records', { limit: 8 })).records ?? []) as Rec[];

const bob = await open(fx.people.member);
const carol = await open(fx.people.member2);
console.log(`${bob.handle} ${bob.agent} → engages ${carol.handle}.me (${carol.agent})`);
const before = await records(carol);
const nonce = Date.now().toString(36);
const r = await call(bob, '/a2a/harness/ask', { message: `ask ${carol.handle}.me: this is a direct message from a gate ${nonce}`, plan: { steps: [{ toolId: 'engagement.agent.invoke', args: { agent: `${carol.handle}.me`, message: `this is a direct message from a gate ${nonce}` }, id: 's0' }] } });
const rep = (r.reply ?? {}) as { kind?: string; text?: string; error?: string; results?: Array<{ toolId: string; result: unknown }>; routed?: Array<{ observedVia?: string; outcome?: string }> };
const text = `${rep.text ?? ''} ${rep.error ?? ''} ${JSON.stringify(rep.results ?? [])}`;
console.log(`bob's reply → ${rep.kind} · routed ${JSON.stringify(rep.routed?.[0] ?? null).slice(0, 120)}`);
console.log(`  ${text.slice(0, 260)}`);
if (!/answers only|send .* a message/i.test(text)) fail(`carol's agent did not refuse at the door in its own words: ${text.slice(0, 400)}`);
if (/inbox messages|invite|canasta|treasury access|knowledge-base/i.test(text)) fail("bob was told what is in carol's records");
await new Promise((res) => setTimeout(res, 1500));
const after = await records(carol);
const fresh = after.filter((x) => !before.some((b) => b.runRef === x.runRef));
const planned = fresh.filter((x) => (x.plan?.steps ?? []).length > 0 && x.door?.kind === 'routed');
console.log(`carol's records: ${fresh.length} new run(s), ${planned.length} routed with a plan`);
if (planned.length) fail(`carol's agent ran a plan for bob's routed ask: ${JSON.stringify(planned.map((x) => x.plan)).slice(0, 200)}`);
console.log("\n✓ spec 366 §6: a person's agent refused a stranger's routed ask at the door, named the right door, and read nothing");
