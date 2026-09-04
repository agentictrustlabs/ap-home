/**
 * Spec 353 S5 — "what am I to this agent", derived and proved from both sides.
 *
 *   npx tsx scripts/verify-standing.mts
 *
 * ONE ask, TWO people, the SAME org. Alice stewards Missio Nexus; Nathan does not. The agent must reach
 * the same authority requirement for both — the plan is identical — and say something DIFFERENT about who
 * can grant it, having read it rather than been told it.
 *
 * A pass proves the honesty is derived: nothing in the request says who is a steward, and the two replies
 * differ only because the evidence in their vaults (and the chain's verdict on it) differs.
 */
const HOME = 'https://www.faithnet.me';
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333'; // Missio Nexus — Alice stewards it
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];

async function askAs(handle: string, message: string) {
  const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-jp' }) }));
  if (!signin.homeSession) throw new Error(`no session for ${handle}`);
  const env = await j(await fetch(`${HOME}/a2a/harness/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' },
    body: JSON.stringify({ session: signin.homeSession, addressee: ORG, message }),
  }));
  return (env.reply ?? env) as Record<string, never> & { kind?: string; standing?: { relation: string; canGrant: boolean; because: string }; note?: string; capability?: string; delegator?: string };
}

const ASK = 'create a team called probe-standing';
let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label} — ${detail}`);
  if (!ok) failures++;
};

console.log(`── the steward asks: "${ASK}" ──`);
const a = await askAs('alice', ASK);
console.log(`  kind=${a.kind} delegator=${(a.delegator ?? '').slice(0, 10)}… standing=${a.standing?.relation ?? '(none read)'}`);
check('reaches an authority requirement', a.kind === 'authority_required', a.kind === 'authority_required' ? a.capability : JSON.stringify(a).slice(0, 200));
check('standing was DERIVED, not absent', !!a.standing, a.standing ? a.standing.because : 'no standing on the reply');
check('the steward may grant', a.standing?.canGrant === true, `canGrant=${a.standing?.canGrant} relation=${a.standing?.relation}`);
check('nothing to warn a steward about', !a.note, a.note ?? '(no note, correct)');

console.log(`\n── a non-steward asks the SAME thing ──`);
const n = await askAs('nathan', ASK);
console.log(`  kind=${n.kind} standing=${n.standing?.relation ?? '(none read)'}`);
check('reaches the same requirement', n.kind === 'authority_required' && n.capability === a.capability, `${n.kind} ${n.capability ?? ''}`);
check('standing says they cannot grant', n.standing?.canGrant === false, `canGrant=${n.standing?.canGrant} relation=${n.standing?.relation}`);
check('and SAYS SO in words a person can read', !!n.note && n.note.length > 20, n.note ?? '(no note)');

console.log(`\n${failures === 0 ? '✓' : '✗'} S5: the same plan, two standings, derived from evidence — ${failures} failure(s).`);
if (failures) process.exit(1);
