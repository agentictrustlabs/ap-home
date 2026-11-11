// Spec 445 §3.6 (audit H-12 / RUNC-3) — WHO IS "ALICE"? The two truth cases, at this runtime's own call site.
//
// The incident class: "send alice 10 dollars" from a person who knows no Alice. The naming registry is public
// and first-come; a stranger who registered `alice.treasury` became the payee, because the registry was
// consulted as if it were the asker's own tier. Now a bare name resolves only from what the asker HOLDS; a
// registry hit can fill the OPTIONS of a question and nothing else, and the question carries the spec-385
// scope so the answer is remembered and asked once.
//
// Driven through `resolveStepArgs` — the function the loop's `normalizeArgs` calls (harness-run.ts) — with the
// lookups shaped as `HarnessDeps` supplies them. The live twins of these two cases are listed in
// SPEC-445-CONSUMER-NOTES.md (they need estate fixtures this file cannot create).
import { describe, expect, it } from 'vitest';
import { isInputRequired } from '@agenticprimitives/orchestration';
import { preferredChoice, rememberConfirmation, type ConfirmationPreferencesV1, type ResolvedParty } from '@agenticprimitives/context';
import { resolveStepArgs } from '../src/harness-run.js';

const ASKER = '0x1dba4a27c53d7babda99513080223fb3bfc4bad1';
const ASKER_TREASURY = '0x2c471607fec409516ab6de6b7517bcf95f1f2edc';
const ALICE = '0x00000000000000000000000000000000000a11ce';
const ALICE_TREASURY = '0x000000000000000000000000000000000a11ce02';     // hers is `alice2.treasury`
const STRANGER_TREASURY = '0x00000000000000000000000000000000000bad00';  // a stranger registered `alice.treasury`

const env = { CHAIN_ID: '34348', DELEGATION_MANAGER: '0x'.padEnd(42, '1'), MOCK_USDC: '0x'.padEnd(42, '2') } as never;
const where = { stepRef: 's0', toolId: 'treasury.payment.execute', capabilityId: 'treasury.payment.execute', authorityArg: 'payer', subject: ASKER };
const row = (agent: string, name: string, kind: string, relationship: string, parent = ASKER) => ({ org: agent, agent, name, orgName: name, kind, parent, relationship, updatedAt: '' });
const mine = row(ASKER_TREASURY, 'nathan.treasury', 'person-treasury', 'steward');

/** The public registry: `alice.treasury` is the stranger's; `alice.me` is Alice. Counted, so a test can say it was not asked. */
function registry() {
  const asked: string[] = [];
  const names: Record<string, string> = { 'alice.treasury': STRANGER_TREASURY, 'alice.me': ALICE, 'alice2.treasury': ALICE_TREASURY };
  return { asked, resolveName: async (n: string) => { asked.push(n); return names[n.toLowerCase()] ?? null; } };
}
/** `prefs` is the person's confirmation memory (her vault's `CONFIRMATION_RECORD`); the port below is wired exactly as
 *  harness-run.ts wires it — `preferredChoice(prefs, scope, candidates)`, which revalidates against the candidates. */
function lookups(opts: { knowsAlice: boolean; prefs?: ConfirmationPreferencesV1 | null }) {
  const reg = registry();
  const resolved: ResolvedParty[] = [];
  const scopes: Array<{ word: string; capability: string; arg: string }> = [];
  const rows = [mine, ...(opts.knowsAlice ? [row(ALICE, 'alice.me', 'person', 'friend')] : [])];
  return {
    reg, resolved, scopes,
    lookups: {
      resolveName: reg.resolveName,
      readSubjectRecord: async (s: string, r: string) => (s.toLowerCase() === ASKER && r === 'relationships.data' ? { orgs: Object.fromEntries(rows.map((x) => [x.agent, x])) } : null),
      // Whose treasuries are whose — the chartered edge, as `HarnessDeps.charteredAgents` reads it.
      charteredAgents: async (owner: string, type: string) => (type !== 'treasury' ? [] : owner.toLowerCase() === ALICE ? [{ agent: ALICE_TREASURY, name: 'alice2.treasury', primary: true }] : owner.toLowerCase() === ASKER ? [{ agent: ASKER_TREASURY, name: 'nathan.treasury', primary: true }] : []),
      onResolved: (r: ResolvedParty) => { resolved.push(r); },
      ...(opts.prefs !== undefined ? { preferredChoice: async (scope: { word: string; capability: string; arg: string }, c: ReadonlyArray<{ agent: string }>) => { scopes.push(scope); const hit = preferredChoice(opts.prefs, scope, c); return hit ? { agent: hit.agent, ...(hit.label ? { label: hit.label } : {}) } : null; } } : {}),
    } as never,
  };
}
const run = (l: ReturnType<typeof lookups>, payee = 'alice') => resolveStepArgs({ payee, usdc: '10' }, env, l.lookups, where).then((out) => ({ out, question: null as null }), (e) => { if (!isInputRequired(e)) throw e; return { out: null, question: e.request }; });
type Field = { name?: string; type?: string; choices?: Array<{ value: string; label: string; hint?: string }>; allowOther?: boolean };

describe('NEGATIVE — "send alice 10 dollars", the asker holds no Alice, a stranger owns alice.treasury', () => {
  it('asks for the payee; the stranger\'s treasury is offered as a public name and is never the payee', async () => {
    const l = lookups({ knowsAlice: false });
    const { out, question } = await run(l);
    expect(out).toBeNull();                                            // no args ⇒ no requirement, no limits, nothing to sign
    expect(question).not.toBeNull();
    const field = (question as unknown as { fields: Field[] }).fields[0]!;
    expect(field.name).toBe('payee');
    expect(field.type).toBe('choice');
    expect(field.allowOther).toBe(true);
    expect(field.choices).toHaveLength(1);                             // a single-choice question is still a question
    expect(field.choices![0]!.value).toBe(STRANGER_TREASURY);
    expect(field.choices![0]!.hint).toMatch(/a public name — not someone you are linked to/);
    expect(l.resolved.some((r) => r.arg === 'payee')).toBe(false);
  });

  it('the question carries the spec-385 scope, so the trusted resume can remember the answer', async () => {
    const { question } = await run(lookups({ knowsAlice: false }));
    expect((question as unknown as { scope?: unknown }).scope).toEqual({ word: 'alice', capability: 'treasury.payment.execute', arg: 'payee' });
  });

  it('answered with the address she picked, the step resolves — and only then', async () => {
    const l = lookups({ knowsAlice: false });
    const out = await resolveStepArgs({ payee: STRANGER_TREASURY, usdc: '10' }, env, l.lookups, where);
    expect(String(out.payee).toLowerCase()).toBe(STRANGER_TREASURY);
    // …and the resolver REPORTS it — the trusted resume in `/harness/ask` reads this entry to write the confirmation.
    expect(l.resolved.some((r) => r.arg === 'payee' && r.agent.toLowerCase() === STRANGER_TREASURY)).toBe(true);
  });

  it('once confirmed (spec 385), the same sentence resolves silently and says the evidence is her confirmation', async () => {
    // Turn 1 raises the question; the trusted resume (index.ts, `/harness/ask`) writes what she picked under the
    // question's own scope. Turn 2 reads it back through the port.
    const first = await run(lookups({ knowsAlice: false, prefs: null }));
    const scope = (first.question as unknown as { scope: { word: string; capability: string; arg: string } }).scope;
    const prefs = rememberConfirmation(null, { ...scope, agent: STRANGER_TREASURY, label: 'alice.treasury', runRef: 'run-1' });
    const l = lookups({ knowsAlice: false, prefs });
    const { out, question } = await run(l);
    expect(question).toBeNull();
    expect(String(out!.payee).toLowerCase()).toBe(STRANGER_TREASURY);
    expect(l.scopes).toContainEqual({ word: 'alice', capability: 'treasury.payment.execute', arg: 'payee' });
    expect(l.resolved.find((r) => r.arg === 'payee')?.evidence).toBe('confirmed');
  });

  it('a remembered choice the registry no longer offers is not used — the question is asked again', async () => {
    const stale = rememberConfirmation(null, { word: 'alice', capability: 'treasury.payment.execute', arg: 'payee', agent: '0x00000000000000000000000000000000000000ee' });
    const { out, question } = await run(lookups({ knowsAlice: false, prefs: stale }));
    expect(out).toBeNull();
    expect(question).not.toBeNull();
  });

  it('a confirmation for another capability or another word does not answer this one', async () => {
    const other = rememberConfirmation(rememberConfirmation(null, { word: 'alice', capability: 'messaging.message.send', arg: 'to', agent: STRANGER_TREASURY }), { word: 'alicia', capability: 'treasury.payment.execute', arg: 'payee', agent: STRANGER_TREASURY });
    expect((await run(lookups({ knowsAlice: false, prefs: other }))).question).not.toBeNull();
  });

  it('a typed public name she holds no link to is a question for a value argument, with the same scope', async () => {
    const { out, question } = await run(lookups({ knowsAlice: false }), 'alice.treasury');
    expect(out).toBeNull();
    const field = (question as unknown as { fields: Field[] }).fields[0]!;
    expect(field.choices!.map((c) => c.value)).toEqual([STRANGER_TREASURY]);
    expect((question as unknown as { scope?: { word: string } }).scope?.word).toBe('alice.treasury');
  });
});

describe('POSITIVE — the same sentence, the asker is linked to alice.me, who holds a treasury', () => {
  it('pays the treasury Alice holds, without a question — and never the stranger\'s alice.treasury', async () => {
    const l = lookups({ knowsAlice: true });
    const { out, question } = await run(l);
    expect(question).toBeNull();
    expect(String(out!.payee).toLowerCase()).toBe(ALICE_TREASURY);
    expect(String(out!.payee).toLowerCase()).not.toBe(STRANGER_TREASURY);
    const payee = l.resolved.find((r) => r.arg === 'payee')!;
    expect(payee.agent).toBe(ALICE_TREASURY);
    expect(payee.evidence).toBeUndefined();                            // found in her own tier — nothing to qualify
    expect(String(out!.amount)).toBe('10000000');
  });
});
