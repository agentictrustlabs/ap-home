/**
 * THE UX/ASK UNIFICATION SCORECARD — spec 361, run against the live estate.
 *
 *   npx tsx scripts/ask-scenario-audit.mts
 *
 * One scenario per Home flow family, driven through /harness/ask as the persona a person would be, and
 * CLASSIFIED: did the Ask reach the same governed capability the screen does, with the right reply kind?
 * Deliberately signature-free — an authority_required naming the right capability IS the pass for an
 * action flow (the ceremony beyond it is covered by the live verify-* gates). Repeatable and cheap, so
 * it can run after any change and the table diffed.
 */
const HOME = 'https://www.faithnet.me';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200) }; } };

const TEAM = '0xfc1c328c26505d1aeab1ead4a46b3f74981f07a4';
const MISSIO = '0x3b99f2b452766de5df0dbcdfc676f27257151333';

interface Scenario {
  id: string;
  persona: string;
  addressee: 'self' | string;
  message: string;
  /** The BUTTON's entry (spec 361 I4): a supplied plan through the same boundary. A parity.* scenario
   *  proves the deterministic path reaches the same governed gate the sentence does — one per converted
   *  family, added AS the family converts, so the scorecard drives the queue. */
  plan?: { steps: Array<{ toolId: string; args: Record<string, unknown> }> };
  /** What unification predicts. */
  expect: { kind: string; capability?: string; textLike?: RegExp; alsoApprove?: boolean };
}

const SCENARIOS: Scenario[] = [
  { id: 'roster.org', persona: 'alice', addressee: MISSIO, message: 'who are the members of this organization', expect: { kind: 'answer', textLike: /member/i } },
  { id: 'roster.team', persona: 'alice', addressee: TEAM, message: 'who are the members on this team', expect: { kind: 'answer', textLike: /nathan|bob|member/i } },
  // `prompt` is also a pass here: Alice stewards several treasuries, and asking WHICH pays is correct
  // behaviour, not a miss — the capability gate comes right after the answer.
  { id: 'payment', persona: 'alice', addressee: MISSIO, message: 'pay bob 1 usdc', expect: { kind: 'authority_required|prompt', capability: 'treasury.payment.execute' } },
  { id: 'invite.oneprompt', persona: 'alice', addressee: TEAM, message: 'invite dave to this team', expect: { kind: 'authority_required', capability: 'organization.membership.invite', alsoApprove: true } },
  { id: 'message.send', persona: 'nathan', addressee: 'self', message: 'send bob a message saying hello from the audit', expect: { kind: 'authority_required', capability: 'messaging.direct.send' } },
  { id: 'treasury.charter', persona: 'nathan', addressee: 'self', message: 'create a treasury called audit-probe', expect: { kind: 'authority_required', capability: 'treasury.create' } },
  { id: 'org.charter', persona: 'nathan', addressee: 'self', message: 'create an organization called audit-probe-org', expect: { kind: 'authority_required', capability: 'organization.create' } },
  { id: 'resolution.request', persona: 'nathan', addressee: 'self', message: 'ask alice.me for a way to reach her treasury', expect: { kind: 'authority_required', capability: 'resolution.invitation.request' } },
  { id: 'vault.question', persona: 'nathan', addressee: 'self', message: 'what kinds of records do I hold in my vault', expect: { kind: 'answer' } },
  { id: 'kb.question', persona: 'nathan', addressee: 'self', message: 'how many organizations are registered in the public directory', expect: { kind: 'answer', textLike: /\d/ } },
  { id: 'standing', persona: 'nathan', addressee: 'self', message: 'am I a member of any organizations', expect: { kind: 'answer' } },
  { id: 'unsupported.honest', persona: 'nathan', addressee: 'self', message: 'book me a flight to denver', expect: { kind: 'answer', textLike: /can't|cannot/i } },
  // The "pay me here" preference, said out loud (spec 361 I4 · third family). Its whole point is to
  // REMOVE a question from every future payer, which `verify-ask-primary-payee.mts` proves end to end.
  { id: 'primary.declare', persona: 'alice', addressee: 'self', message: 'payments to me should go to alice3.treasury',
    expect: { kind: 'authority_required', capability: 'treasury.primary.declare' } },
  // Access hygiene (spec 361 I4 · fourth family). The audit runs NO gate — reading your own list of who
  // you authorized changes nothing — and the revoke is an on-chain kill, proved by
  // `verify-ask-access-revoke.mts` rather than by this row, which proves the offer.
  { id: 'access.audit', persona: 'alice', addressee: 'self', message: 'which apps can read my records',
    expect: { kind: 'answer' } },
  { id: 'access.revoke', persona: 'alice', addressee: 'self', message: 'stop demo-jp from reading my records',
    expect: { kind: 'authority_required', capability: 'access.grant.revoke' } },
  // The profile family (spec 361 I4 · fifth). The edit needs NO signature — the record is the person's
  // own, so the capability is SELF-ACTING — which is why this row expects `done` where every other act
  // expects an authority card. The read states its tier, because three records answer to "profile".
  { id: 'profile.read', persona: 'alice', addressee: 'self', message: 'what does my profile say',
    expect: { kind: 'answer', textLike: /private/i } },
  { id: 'profile.edit', persona: 'alice', addressee: 'self', message: 'set my first name to Alice',
    expect: { kind: 'done' } },
  // The household (spec 363 W4). The read states its tier; the record is SELF-ACTING (no signature);
  // and the payment proves the point of the whole wave — "my daughter" resolves inside the asker's own
  // private record, so a payment to her needs no question about who she is.
  { id: 'household.read', persona: 'alice', addressee: 'self', message: 'who is in my household',
    expect: { kind: 'answer', textLike: /private/i } },
  // `prompt` is a PASS here too, and not a hedge: a marked account that cannot cover the act must not
  // decide (spec 363 — using it silently would turn a preference into a wrong answer), so when alice's
  // payer runs low the question honestly comes back. What this row asserts is that "my daughter" is
  // understood — the payment capability is reached either way.
  { id: 'household.payment', persona: 'alice', addressee: 'self', message: 'send my daughter 1 usdc',
    expect: { kind: 'authority_required|prompt', capability: 'treasury.payment.execute' } },
  // ── parity.* — the SCREENS' deterministic entries, one per converted family ──
  { id: 'parity.invite.plan', persona: 'alice', addressee: TEAM, message: 'invite elena to this team',
    plan: { steps: [{ toolId: 'organization.membership.invite', args: { org: TEAM, invitee: '0xa7230405fabac0e5cae7d749c35bd2af91d84472' } }] },
    expect: { kind: 'authority_required', capability: 'organization.membership.invite', alsoApprove: true } },
  { id: 'parity.fund.plan', persona: 'nathan', addressee: '0x2c471607fec409516ab6de6b7517bcf95f1f2edc', message: 'fund my treasury with 5 usdc',
    plan: { steps: [{ toolId: 'treasury.fund', args: { treasury: '0x2c471607fec409516ab6de6b7517bcf95f1f2edc', amount: '5000000' } }] },
    expect: { kind: 'authority_required', capability: 'treasury.fund' } },
  { id: 'parity.primary.plan', persona: 'alice', addressee: 'self', message: 'payments to me should go to alice3.treasury',
    plan: { steps: [{ toolId: 'treasury.primary.declare', args: { treasury: '0xa6d91f28c0b310b3495520f96f453011ccaf3479', on: true } }] },
    expect: { kind: 'authority_required', capability: 'treasury.primary.declare' } },
  { id: 'parity.profile.plan', persona: 'alice', addressee: 'self', message: 'update my profile (city)',
    plan: { steps: [{ toolId: 'profile.contact.update', args: { city: 'Longmont' } }] },
    expect: { kind: 'done' } },
  { id: 'parity.household.plan', persona: 'alice', addressee: 'self', message: 'record carol in my household',
    plan: { steps: [{ toolId: 'household.member.record', args: { member: '0x6fece74d4c13ba2b408a7531e6e44d02dcb3f015', kin: 'daughter', role: 'dependent' } }] },
    expect: { kind: 'done' } },
];

const sessions = new Map<string, { token: string; agent: string; cookie: string; csrf: string }>();
async function sessionFor(handle: string) {
  if (sessions.has(handle)) return sessions.get(handle)!;
  const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-jp' }) }));
  const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
  const csrf = (await j(csrfRes)) as { token?: string };
  const s = { token: si.homeSession as string, agent: String(si.agent).toLowerCase(), cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', csrf: csrf.token ?? '' };
  sessions.set(handle, s);
  return s;
}

let pass = 0; let fail = 0;
const rows: string[] = [];
for (const sc of SCENARIOS) {
  const s = await sessionFor(sc.persona);
  const addressee = sc.addressee === 'self' ? s.agent : sc.addressee;
  const started = Date.now();
  const r = await j(await fetch(`${HOME}/a2a/harness/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie: s.cookie, 'x-csrf-token': s.csrf },
    body: JSON.stringify({ session: s.token, addressee, message: sc.message, ...(sc.plan ? { plan: sc.plan } : {}) }),
  })) as { reply?: { kind?: string; capability?: string; text?: string; alsoApprove?: unknown[] } ; error?: string };
  const rep = r.reply ?? { kind: `ERROR:${r.error ?? 'no reply'}` };
  const problems: string[] = [];
  if (!sc.expect.kind.split('|').includes(String(rep.kind))) problems.push(`kind=${rep.kind}≠${sc.expect.kind}`);
  if (sc.expect.capability && rep.kind === 'authority_required' && rep.capability !== sc.expect.capability) problems.push(`cap=${rep.capability ?? '—'}`);
  if (sc.expect.textLike && !(sc.expect.textLike.test(rep.text ?? ''))) problems.push(`text!~${sc.expect.textLike}`);
  if (sc.expect.alsoApprove && !(Array.isArray(rep.alsoApprove) && rep.alsoApprove.length)) problems.push('no alsoApprove');
  const ok = problems.length === 0;
  if (ok) pass++; else fail++;
  rows.push(`| ${sc.id} | ${sc.persona} | ${ok ? '✅' : '❌ ' + problems.join(', ')} | ${((Date.now() - started) / 1000).toFixed(1)}s | ${(rep.text ?? rep.kind ?? '').toString().replace(/\n/g, ' ').slice(0, 90)} |`);
  console.log(`${ok ? '✅' : '❌'} ${sc.id} (${((Date.now() - started) / 1000).toFixed(1)}s)${ok ? '' : ' — ' + problems.join(', ')}`);
}
console.log(`\n${pass}/${SCENARIOS.length} scenarios hold; ${fail} finding(s).`);
console.log('\n| scenario | persona | verdict | latency | reply head |');
console.log('| --- | --- | --- | --- | --- |');
for (const row of rows) console.log(row);
if (fail) process.exit(1);
