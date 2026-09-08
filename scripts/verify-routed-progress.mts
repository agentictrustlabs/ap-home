/**
 * Appendix M8 — cross-agent progress and records, live.
 *
 *   npx tsx scripts/verify-routed-progress.mts
 *
 * alice asks her own agent who the members of Missio Nexus are. The step routes to missio-nexus.org;
 * while that agent works, ITS progress lines are relayed into alice's run — "missio-nexus.org: Reading
 * who belongs…" — and her answer cites the receiver's run by the reference her agent named for it. The
 * receiver's record stays on the receiver's object; alice holds the reference and the receipts' status.
 */
import type { Address } from 'viem';

const HOME = 'https://faithnet.me';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const ALICE = String(si.agent).toLowerCase() as Address;
const host = 'https://alice.faithnet.ai';
const cr = await fetch(`${host}/auth/csrf`, { headers: { origin: HOME, 'user-agent': UA } });
const csrf = cr.headers.get('x-csrf-token') || ((await j(cr.clone())) as { token?: string }).token || '';
const cookie = (cr.headers.get('set-cookie') || '').split(';')[0] ?? '';
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf, 'user-agent': UA };

// The client mints the run ref (the flyout does the same), so progress can be read from the first line.
const runRef = `run-${crypto.randomUUID()}`;
const message = 'who are the members of Missio Nexus';
console.log(`alice ${ALICE} asks: "${message}"  (run ${runRef.slice(0, 18)}…)`);
const askP = j(await fetch(`${host}/harness/ask`, { method: 'POST', headers: H, body: JSON.stringify({ session: si.homeSession, addressee: ALICE, message, runRef }) }).catch((e) => new Response(JSON.stringify({ error: String(e) }))));

type Line = { seq: number; type: string; said: string; from?: { agent: string; name?: string }; terminal?: boolean };
const lines: Line[] = [];
let after = 0;
for (let i = 0; i < 60; i++) {
  const got = await j(await fetch(`${host}/harness/progress`, { method: 'POST', headers: H, body: JSON.stringify({ session: si.homeSession, addressee: ALICE, runRef, after, wait: 3000 }) })) as { ok?: boolean; lines?: Line[]; terminal?: boolean };
  for (const l of got.lines ?? []) { lines.push(l); after = Math.max(after, l.seq); console.log(`  ${String(l.seq).padStart(2)} ${l.type.padEnd(14)} ${l.said}`); }
  if (got.terminal) break;
}
const reply = (await askP).reply as { kind?: string; text?: string; routed?: Array<{ agent: string; name?: string; runRef?: string; observedVia: string; receipts?: number }> } | undefined;
console.log(`\nreply: ${reply?.kind} — ${JSON.stringify(reply?.text ?? '').slice(0, 120)}`);
const via = reply?.routed?.[0];
console.log(`cited: ${via ? `${via.name ?? via.agent} run ${via.runRef} (${via.observedVia}, ${via.receipts ?? 0} receipt(s))` : 'nothing'}`);
const relayed = lines.filter((l) => l.type === 'Relayed');
console.log(`relayed lines: ${relayed.length}${relayed[0] ? ` — first: "${relayed[0].said}" from ${relayed[0].from?.name ?? relayed[0].from?.agent}` : ''}`);
if (!via?.runRef || via.runRef !== `routed-${runRef}-s0`) throw new Error(`the answer does not cite the receiver's run by the reference the sender named (got ${via?.runRef})`);
if (!relayed.length) throw new Error('no line from the subject agent was relayed into the asker\'s progress');
if (!relayed.every((l) => l.from?.agent && /missio-nexus/i.test(l.said))) throw new Error('a relayed line does not name the subject agent');
// P6 — REPLAY: the record answers, nothing runs. The routed step comes back with the receiver's run cited
// exactly as recorded (both sides' verdicts: this run's 'routed' authority, the receiver's receipts).
const rp = await j(await fetch(`${host}/harness/replay`, { method: 'POST', headers: H, body: JSON.stringify({ session: si.homeSession, addressee: ALICE, runRef }) })) as { ok?: boolean; error?: string; outcome?: string; steps?: Array<{ stepRef: string; replayed: boolean; via?: { name?: string; agent: string; runRef?: string; observedVia?: string; receipts: number } }> };
const rstep = rp.steps?.[0];
console.log(`replay: ${rp.ok ? `${rp.outcome} — step ${rstep?.stepRef} replayed, cites ${rstep?.via ? `${rstep.via.name ?? rstep.via.agent} run ${rstep.via.runRef} (${rstep.via.receipts} receipt(s))` : 'nothing'}` : rp.error}`);
if (!rp.ok || !rstep?.replayed || rstep.via?.runRef !== via.runRef) throw new Error(`the replay does not cite the receiver's run as recorded: ${JSON.stringify(rp).slice(0, 300)}`);
console.log(`\n✓ appendix M8: the subject agent's own progress was relayed into the asker's run as it happened, and the answer cites the receiver's run by reference — its record stays on its own object.`);
