/**
 * Spec 379 W1 — AN OUTSIDE A2A 1.0 AGENT AS A STEP, live.
 *
 *   npx tsx scripts/verify-external-agent.mts
 *
 * alice asks her agent to ask `clock.external` — a standards-only A2A 1.0 agent on the Home's origin,
 * reached by the Worker over the public network like any foreign agent — what time it is. The answer
 * names who said it and cites the card. Twin: a supplied payment plan whose executor is that agent is
 * refused at admission (EXTERNAL_EXECUTOR_ACT) — no mandate asked, no re-plan, nothing ran.
 */
const HOME = 'https://www.faithnet.me';
const CARD = 'https://faithnet.me/external-agent/card';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const card = await j(await fetch(CARD));
if (card?.name !== 'clock.external') throw new Error(`the clock is not served: ${JSON.stringify(card).slice(0, 200)}`);
console.log(`clock.external served at ${CARD} → ${card.supportedInterfaces?.[0]?.url}`);
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const ALICE = String(alice.agent).toLowerCase();
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const A2A = 'https://alice.faithnet.ai';
const csrfRes = await fetch(`${A2A}/auth/csrf`, { headers: { origin: HOME, 'user-agent': UA } });
const csrfTok = csrfRes.headers.get('x-csrf-token') || ((await j(csrfRes.clone())) as { token?: string }).token || '';
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrfTok, 'user-agent': UA };
const post = async (path: string, body: unknown) => j(await fetch(`${A2A}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
type Reply = { kind?: string; text?: string; error?: string; runRef?: string; evidence?: unknown; trace?: { admission?: Array<{ refused: Array<{ code: string; message: string }>; replanned: boolean }> } };

// ── 1. the read: an outside agent answers ───────────────────────────────────────────────────────────
const t0 = Date.now();
const r1 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, message: `ask the agent at ${CARD} what time it is` });
const rep = r1.reply as Reply;
console.log(`ask → ${rep?.kind} (${((Date.now() - t0) / 1000).toFixed(1)}s): ${rep?.text?.slice(0, 220)}${rep?.error ? ` · ${rep.error.slice(0, 200)}` : ''}`);
if (rep?.kind !== 'answer') throw new Error(`expected an answer: ${JSON.stringify(r1).slice(0, 600)}`);
if (!/clock\.external|outside agent|external agent/i.test(rep.text ?? '')) throw new Error(`the answer does not say who said it: ${rep.text}`);
const ev = JSON.stringify(rep.evidence ?? r1);
if (!/cardDigest|card/i.test(ev)) throw new Error(`the answer does not cite the card: ${ev.slice(0, 400)}`);
console.log(`  ✓ the answer names clock.external and cites its card`);

// ── 2. the twin: a value-moving step aimed at the outside agent is refused at admission ──────────────
const plan = { steps: [{ toolId: 'treasury.payment.execute', args: { payee: 'nathan.treasury', usdc: '1', memo: 'external twin' }, id: 's0', executor: CARD }] };
const r2 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, message: `pay nathan.treasury 1 usdc (external twin ${Date.now().toString(36)})`, plan });
const rep2 = r2.reply as Reply;
console.log(`twin → ${rep2?.kind}: ${(rep2?.error ?? rep2?.text ?? '').slice(0, 240)}`);
if (rep2?.kind === 'authority_required') throw new Error('a mandate was asked for a step an outside agent was to run — the rule did not hold');
if (rep2?.kind !== 'refused' || !/EXTERNAL_EXECUTOR_ACT|outside|external/i.test(rep2?.error ?? '')) throw new Error(`expected an admission refusal: ${JSON.stringify(r2).slice(0, 600)}`);
const adm = rep2.trace?.admission ?? [];
if (adm.some((a) => a.replanned)) throw new Error(`the refusal was re-planned around: ${JSON.stringify(adm)}`);
console.log(`  ✓ refused at admission, no re-plan, no mandate asked`);
console.log('\nspec 379 W1 live: an outside agent answered a read step; the act aimed at it was refused. ✓');
