/**
 * JUDGE ONE RUN OF AN AGENT — spec 438 §5, from the command line.
 *
 *   npx tsx scripts/assess-run.mts <agent 0x…> <runRef> <evaluator handle> <criterionId>=<passed|failed|cantTell> [more…]
 *
 * Two phases against `POST /harness/assess`: the server builds the assessment it WOULD store (subject from the
 * run's own anchor digest, criteria from the work it names or else the agent's own playbook) and returns the
 * digest; this signs that digest AS the evaluator through the Home (`persona-sign`, the evaluator's own
 * credential) and posts it back. The server verifies the signature against the evaluator's Smart Agent and
 * appends the assessment beside the run. It edits nothing about the run.
 *
 * This script holds no key. It names no subject digest and no criteria — both are the server's, and that is
 * the point: a client that could name the subject digest could sign a judgment of a document that was never
 * the run.
 */
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const [agentRaw, runRef, by, ...verdictArgs] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{40}$/.test(agentRaw ?? '') || !runRef || !by || verdictArgs.length === 0) {
  console.error('usage: assess-run.mts <agent 0x…> <runRef> <evaluator handle> <criterionId>=<passed|failed|cantTell> […]');
  process.exit(2);
}
const agent = agentRaw!.toLowerCase();
const results = verdictArgs.map((v) => {
  const [criterionId, outcome] = v.split('=');
  if (!criterionId || !['passed', 'failed', 'cantTell', 'inapplicable', 'untested'].includes(outcome ?? '')) throw new Error(`bad verdict "${v}"`);
  return { criterionId, outcome, evidenceRefs: [] as string[] };
});

const j = async (r: Response): Promise<Record<string, unknown>> => { const t = await r.text(); try { return JSON.parse(t) as Record<string, unknown>; } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: by, client_id: 'demo-web' }) }));
const token = signin.homeSession as string | undefined;
if (!token) throw new Error(`no session for ${by}: ${JSON.stringify(signin).slice(0, 160)}`);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const assess = (body: Record<string, unknown>) => fetch(`${HOME}/a2a/harness/assess`, { method: 'POST', headers: H, body: JSON.stringify({ session: token, addressee: agent, runRef, results, ...body }) }).then(j);

// THE EVIDENCE A VERDICT RESTS ON: the run's own receipts, by digest. A `passed` or `failed` that cites nothing
// is refused by the validator, and rightly — a verdict with no evidence is an opinion with a signature on it.
// Read from the run's provenance so the refs are the run's and not this script's.
const prov = await fetch(`${HOME}/a2a/harness/provenance`, { method: 'POST', headers: H, body: JSON.stringify({ session: token, addressee: agent, runRef, format: 'record' }) }).then(j);
const receipts = ((prov.record as { steps?: Array<{ receiptDigest?: string }> } | undefined)?.steps ?? []).map((st) => st.receiptDigest).filter((d): d is string => typeof d === 'string' && d.startsWith('0x'));
if (!receipts.length) { console.error(`run ${runRef} left no receipt digest to cite; nothing to rest a verdict on`); process.exit(1); }
for (const r of results) if (r.outcome === 'passed' || r.outcome === 'failed') r.evidenceRefs = receipts.map((d) => `urn:ap:receipt:${d}`);
console.log(`citing ${receipts.length} receipt(s): ${receipts.map((d) => d.slice(0, 12) + '…').join(', ')}`);

// PHASE ONE — what the server would store, and what to sign.
const prepared = await assess({});
if (prepared.ok !== true) { console.error('prepare refused:', JSON.stringify(prepared).slice(0, 400)); process.exit(1); }
const a = prepared.assessment as { subject: { runRef: string; recordDigest: string; at: string }; criteria: { outcomeId: string; revision: number; digest: string; statedAt: string }; at: string };
console.log(`criteria from ${String(prepared.criteriaFrom)}: ${a.criteria.outcomeId} (rev ${a.criteria.revision}, ${a.criteria.digest.slice(0, 18)}…) stated ${a.criteria.statedAt}`);
console.log(`subject: ${a.subject.runRef} @ ${a.subject.recordDigest.slice(0, 18)}… ended ${a.subject.at}`);
console.log(`assessment digest ${String(prepared.digest).slice(0, 22)}… → sign ${String(prepared.signDigest).slice(0, 14)}…`);

// SIGN AS THE EVALUATOR, through the Home — their own credential, verifiable against their Smart Agent.
const sig = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest: prepared.signDigest }) }));
if (!sig.signature) throw new Error(`persona-sign: ${JSON.stringify(sig).slice(0, 160)}`);

// PHASE TWO — the same inputs plus the signature; `at` echoed so the two phases hash identically.
const stored = await assess({ signature: sig.signature, at: a.at });
if (stored.ok !== true) { console.error('commit refused:', JSON.stringify(stored).slice(0, 400)); process.exit(1); }
console.log(`${stored.stored ? 'STORED' : 'already held'}: ${String(stored.digest).slice(0, 22)}… (${String(stored.held ?? '?')} held for this run)`);
