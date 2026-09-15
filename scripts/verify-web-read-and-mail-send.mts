/**
 * Spec 402 W5 — A PAGE READ AS EVIDENCE, and MAIL THAT LEAVES ONLY UNDER HER SIGNATURE.
 *
 *   npx tsx scripts/verify-web-read-and-mail-send.mts        (from the repo root)
 *
 * The steward asks her own agent to read a public page (a supplied plan — no model): the answer carries the page's title
 * and words, the contract's app binding (WebPageCard), and the words are marked as the page's, never instructions.
 * Twins: a link-local address is refused as an OUTCOME the reply states (never fetched, never guessed); "send it" —
 * gmail.message.send — never runs on a word: the reply is authority_required for that capability, as her, while the
 * Gmail READ with the same standing answers at once ("not connected" on a home with no Gmail — an answer, not a park).
 */
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME } from './fixture.mts';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const fail = (m: string): never => { console.error(`✗ ${m}`); process.exit(1); };
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const steward = await personaCustodian(HOME, fx.people.steward);
const me = steward.agent.toLowerCase();
console.log(`── ${fx.people.steward} asks her agent to read a page; then to send mail ──`);

// 1. a public page, read as evidence
const URL_ = 'https://example.com/';
const read = await post('/harness/ask', { session: steward.bearer, addressee: me, message: `what does ${URL_} say`, plan: { steps: [{ toolId: 'web.page.read', args: { url: URL_ } }] } });
const row = ((read.reply?.results ?? []) as Array<{ toolId: string; result: { read?: boolean; title?: string; text?: string; untrusted?: boolean; note?: string; refused?: string } }>).find((x) => x.toolId === 'web.page.read')?.result;
if (read.reply?.kind !== 'answer' || !row?.read) fail(`the page was not read: ${JSON.stringify(read).slice(0, 400)}`);
if (!/example domain/i.test(String(row.title)) || !/documentation examples|illustrative examples/i.test(String(row.text))) fail(`not the page's words: ${JSON.stringify(row).slice(0, 300)}`);
if (row.untrusted !== true || !/never instructions/.test(String(row.note))) fail('the page\'s words are not marked as the page\'s');
if (read.reply?.interaction?.result !== 'WebPageCard') fail(`no WebPageCard binding on the reply: ${JSON.stringify(read.reply?.interaction)}`);
if (!/example/i.test(String(read.reply?.text))) fail(`the answer does not speak of the page: "${String(read.reply?.text).slice(0, 200)}"`);
console.log(`  read "${row.title}" (${String(row.text).length} chars, WebPageCard) → "${String(read.reply.text).slice(0, 90).replace(/\n/g, ' ')}…" ✓`);

// twin A — a private address is an outcome, never a fetch
const leak = await post('/harness/ask', { session: steward.bearer, addressee: me, message: 'read http://169.254.169.254/latest/meta-data', plan: { steps: [{ toolId: 'web.page.read', args: { url: 'http://169.254.169.254/latest/meta-data' } }] } });
const leakRow = ((leak.reply?.results ?? []) as Array<{ toolId: string; result: { read?: boolean; refused?: string } }>).find((x) => x.toolId === 'web.page.read')?.result;
if (leakRow?.read !== false || !/not on the public web/.test(String(leakRow.refused))) fail(`twin: a link-local address was not refused as an outcome: ${JSON.stringify(leak).slice(0, 300)}`);
console.log(`  twin: 169.254.169.254 → "${leakRow.refused}" ✓`);

// 2. "send it" parks for her signature — the act never runs on a word
const send = await post('/harness/ask', { session: steward.bearer, addressee: me, message: 'send the draft', plan: { steps: [{ toolId: 'gmail.message.send', args: { draftId: 'r-gate-draft' } }] } });
if (send.reply?.kind !== 'authority_required' || send.reply?.capability !== 'gmail.message.send' || String(send.reply?.delegator ?? '').toLowerCase() !== me) fail(`send did not park for her signature: ${JSON.stringify(send).slice(0, 400)}`);
const actions = (send.reply?.requirement?.actions ?? []) as string[];
if (!actions.includes('gmail.message.send')) fail(`the requirement does not name the send: ${JSON.stringify(send.reply?.requirement).slice(0, 200)}`);
console.log(`  send → authority_required for gmail.message.send as ${me.slice(0, 10)}… (ceremony: signature) ✓`);
// twin B — the READ with the same standing answers at once: not connected is an answer, not a park
const mail = await post('/harness/ask', { session: steward.bearer, addressee: me, message: 'any mail from the pastor', plan: { steps: [{ toolId: 'gmail.threads.search', args: { query: 'from:pastor' } }] } });
const mailRow = ((mail.reply?.results ?? []) as Array<{ toolId: string; result: { connected?: boolean; refused?: string } }>).find((x) => x.toolId === 'gmail.threads.search')?.result;
if (mail.reply?.kind !== 'answer' || !mailRow || (mailRow.connected !== false && mailRow.connected !== true)) fail(`twin: the mail read did not answer: ${JSON.stringify(mail).slice(0, 300)}`);
console.log(`  twin: the Gmail read answered at once (${mailRow.connected ? 'connected' : 'not connected — said so'}) ✓`);
console.log('✓ verify-web-read-and-mail-send — a page read as evidence with its app; a private address refused as an outcome; mail leaves only under her signature while a read answers on her standing');
