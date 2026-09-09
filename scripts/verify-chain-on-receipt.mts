/**
 * Spec 383 W2 — THE STEWARD WIRE AS A NAMED LINK on a routed run's receipt, live.
 *
 *   npx tsx scripts/verify-chain-on-receipt.mts
 *
 * alice asks her own agent for Missio Nexus's roster (a supplied plan — no planner). The ask is ROUTED to the
 * organization (spec 366), which runs the read under the standing alice presents; its receipt's binding names
 * that standing: for Missio Nexus, steward, under the stewardship wire it verified — by digest. The Home
 * renders the same line under the answer.
 */
const HOME = 'https://www.faithnet.me';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333'; // Missio Nexus
type Standing = { relation: string; subject: string; principal: string; because: string; wireRef?: string };
const r = await post('/harness/ask', { session: alice.homeSession, addressee: String(alice.agent).toLowerCase(), message: 'who is in missio nexus', plan: { steps: [{ toolId: 'organization.membership.list', args: { org: 'missio nexus' } }] } });
const rep = r.reply as { kind?: string; text?: string; error?: string; routed?: Array<{ agent: string; name?: string; observedVia?: string; runRef?: string; receipts?: number; standing?: Standing }> };
console.log(`ask → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
if (rep?.kind !== 'answer') fail(`expected an answer: ${JSON.stringify(r).slice(0, 500)}`);
const hop = (rep.routed ?? []).find((x) => x.agent.toLowerCase() === ORG);
if (!hop) fail(`the read was not routed to Missio Nexus: ${JSON.stringify(rep.routed ?? []).slice(0, 300)}`);
const st = hop!.standing;
console.log(`routed to ${hop!.name ?? hop!.agent} (${hop!.observedVia}, run ${hop!.runRef}) — ${hop!.receipts ?? 0} receipt(s)`);
console.log(`standing on the receipt: ${st ? `${st.relation} — for ${st.subject.slice(0, 10)}…, by ${st.principal.slice(0, 10)}…, wire ${st.wireRef ?? '(none)'} — "${st.because}"` : 'NONE'}`);
if (!st) fail('the organization\'s receipt names no standing');
if (st.relation !== 'steward' || st.subject.toLowerCase() !== ORG || st.principal.toLowerCase() !== String(alice.agent).toLowerCase()) fail('the standing does not say alice acted for Missio Nexus as its steward');
if (!/^0x[0-9a-f]{64}$/i.test(st.wireRef ?? '')) fail('the steward wire is not named by digest');
console.log(`\n✓ spec 383 W2: the routed act's receipt at the organization names the steward and the wire: for Missio Nexus, under steward wire ${st.wireRef!.slice(0, 14)}…`);
