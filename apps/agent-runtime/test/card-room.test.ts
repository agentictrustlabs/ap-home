// THE CARD ROOM'S THREE ASKS, and the invariants the coach-service arrangement holds (`card-room.ts`):
//   · a person's agent GENERATES NOTHING — poker.advise consults, poker.record puts, poker.review forwards;
//   · the only model on a hand's clock is the coach service's, under a verified study grant;
//   · the grant is to a SERVICE, scoped to her study records, writes nothing but the coach's note;
//   · her records are read from HER vault; the coach's one write is a note into HER cabinet;
//   · a hand ending never reaches the coach; a review is asked for.
import { describe, it, expect } from 'vitest';
import { buildVaultRecordScopeCaveat, VAULT_RECORD_SCOPE_ENFORCER, TIMESTAMP_ENFORCER } from '@agenticprimitives/delegation';
import {
  HANDS_KEPT, HAND_RECORD, NOTE_RECORD, STUDY_SERVER,
  appendNote, cardRoomActOf, cardRoomTurn, isHandRecord, recordHand, reviewScopeOf, studyFrom, studyGrantOf, verifyStudyGrant,
} from '../src/card-room.js';
import { PLAYBOOK_ANSWER_TOOL, playbookAnswerInvoker } from '../src/playbook-answer.js';
import type { IncomingWire } from '../src/org-wire.js';

const ALICE = '0x' + 'a'.repeat(40);
const COACH = '0x' + 'c'.repeat(40);
const BOB = '0x' + 'b'.repeat(40);

const ctx = { step: { id: 's1', toolId: PLAYBOOK_ANSWER_TOOL.id, args: {} }, index: 0 } as never;

function grantWire(input: { delegator?: string; delegate?: string; scopes?: Array<{ resources: string[]; ops: Array<'read' | 'write' | 'delete'> }>; caveats?: boolean } = {}): IncomingWire {
  const scopes = input.scopes ?? [{ resources: ['vault:cardroom.hand', 'vault:cardroom.style', 'vault:cardroom.read', 'vault:cardroom.note'], ops: ['read'] }, { resources: ['vault:cardroom.note'], ops: ['write'] }];
  const cav = buildVaultRecordScopeCaveat(scopes.map((s) => ({ server: STUDY_SERVER, ...s })));
  return {
    delegator: input.delegator ?? ALICE, delegate: input.delegate ?? COACH, authority: ('0x' + '0'.repeat(64)) as `0x${string}`,
    caveats: input.caveats === false ? [] : [{ enforcer: cav.enforcer, terms: cav.terms }],
    salt: '1', signature: ('0x' + '11'.repeat(65)) as `0x${string}`,
  };
}

/** The substrate's chain checks, faked: every wire is genuinely signed and unrevoked unless told otherwise. */
const checks = (o: { revoked?: boolean; signed?: boolean } = {}) => ({
  digest: () => ('0x' + 'd'.repeat(64)) as `0x${string}`,
  erc1271: async () => o.signed !== false,
  isRevoked: async () => o.revoked === true,
});
const enforcers = { delegationManager: ('0x' + '1'.repeat(40)) as `0x${string}`, timestamp: TIMESTAMP_ENFORCER, value: ('0x' + '2'.repeat(40)) as `0x${string}`, allowedTargets: ('0x' + '3'.repeat(40)) as `0x${string}`, allowedMethods: ('0x' + '4'.repeat(40)) as `0x${string}` };

const hand = (handNo: number, extra: Record<string, unknown> = {}) => ({
  skill: 'poker.record', tableId: 't1', handNo, seat: 0, view: { hand: { street: 'showdown', board: ['As', 'Kd', '7c', '2h', '9s'] }, me: ['Ah', 'Kh'] },
  observation: { subjects: { 'agent:sharkbot.svc': { label: 'Sharkbot', counters: { hands: 1, vpip: 1, pfr: 1, cbetOpps: 1, cbet: 1 } }, me: { you: true, counters: { hands: 1, vpip: 1, netChips: handNo % 2 ? 12 : -8 } } } },
  ...extra,
});

describe('which asks are the card room\'s', () => {
  it('names the act by the skill\'s last segment, for any game', () => {
    expect(cardRoomActOf('poker.advise')).toBe('advise');
    expect(cardRoomActOf('canasta.record')).toBe('record');
    expect(cardRoomActOf('poker.review')).toBe('review');
    expect(cardRoomActOf('poker.act')).toBeNull(); // a TURN is never advice — poker.act ≠ poker.advise ≠ poker.record
    expect(cardRoomActOf('payment.send')).toBeNull();
    expect(cardRoomActOf(null)).toBeNull();
  });
});

describe('the study grant', () => {
  it('verifies a grant from the person to the SERVICE, scoped to her study records, live on chain', async () => {
    const r = await verifyStudyGrant({ grant: { wire: grantWire(), hash: '0xabc' }, delegator: ALICE, delegate: COACH, enforcers, checks: checks() });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.access.owner).toBe(ALICE);
      expect(r.access.delegate).toBe(COACH);
      expect(r.access.reads).toEqual(['cardroom.hand', 'cardroom.style', 'cardroom.read', 'cardroom.note']);
      expect(r.access.appends).toEqual(['cardroom.note']);
    }
  });

  it('is refused when it names a different coach, a different person, or none was presented', async () => {
    expect(await verifyStudyGrant({ grant: { wire: grantWire({ delegate: BOB }), hash: '' }, delegator: ALICE, delegate: COACH, enforcers, checks: checks() })).toEqual({ ok: false, reason: 'the study grant names a different coach' });
    expect(await verifyStudyGrant({ grant: { wire: grantWire({ delegator: BOB }), hash: '' }, delegator: ALICE, delegate: COACH, enforcers, checks: checks() })).toEqual({ ok: false, reason: 'the study grant was not signed by the person being advised' });
    expect(await verifyStudyGrant({ grant: null, delegator: ALICE, delegate: COACH, enforcers, checks: checks() })).toEqual({ ok: false, reason: 'no study grant was presented' });
  });

  it('is refused when revoked or not genuinely signed — the substrate decides liveness', async () => {
    expect((await verifyStudyGrant({ grant: { wire: grantWire(), hash: '' }, delegator: ALICE, delegate: COACH, enforcers, checks: checks({ revoked: true }) })).ok).toBe(false);
    expect((await verifyStudyGrant({ grant: { wire: grantWire(), hash: '' }, delegator: ALICE, delegate: COACH, enforcers, checks: checks({ signed: false }) })).ok).toBe(false);
  });

  it('NO SCOPE ⇒ NO; a grant that does not read her hands, or writes anything but the note, is refused whole', async () => {
    expect(await verifyStudyGrant({ grant: { wire: grantWire({ caveats: false }), hash: '' }, delegator: ALICE, delegate: COACH, enforcers, checks: checks() })).toEqual({ ok: false, reason: 'the study grant carries no record scope' });
    const noHands = grantWire({ scopes: [{ resources: ['vault:cardroom.style'], ops: ['read'] }] });
    expect(await verifyStudyGrant({ grant: { wire: noHands, hash: '' }, delegator: ALICE, delegate: COACH, enforcers, checks: checks() })).toEqual({ ok: false, reason: 'the study grant does not read her hands' });
    const writesHands = grantWire({ scopes: [{ resources: ['vault:cardroom.hand'], ops: ['read', 'write'] }] });
    expect(await verifyStudyGrant({ grant: { wire: writesHands, hash: '' }, delegator: ALICE, delegate: COACH, enforcers, checks: checks() })).toEqual({ ok: false, reason: 'the study grant writes more than the coach’s notes' });
  });

  it('a read-only grant is honoured as read-only: no append scope, no note', async () => {
    const readOnly = grantWire({ scopes: [{ resources: ['vault:cardroom.hand', 'vault:cardroom.note'], ops: ['read'] }] });
    const r = await verifyStudyGrant({ grant: { wire: readOnly, hash: '' }, delegator: ALICE, delegate: COACH, enforcers, checks: checks() });
    expect(r.ok && r.access.appends).toEqual([]);
    expect(r.ok && r.access.reads).toEqual(['cardroom.hand', 'cardroom.note']);
  });

  it('reads the grant out of the consultation\'s material, and nothing that is not a wire', () => {
    expect(studyGrantOf({ skill: 'poker.advise', grant: { wire: grantWire(), hash: '0x1' } })?.hash).toBe('0x1');
    expect(studyGrantOf({ skill: 'poker.advise' })).toBeNull();
    expect(studyGrantOf({ skill: 'poker.advise', grant: { wire: { delegator: ALICE } } })).toBeNull();
    expect(VAULT_RECORD_SCOPE_ENFORCER).toMatch(/^0x/);
  });
});

describe('poker.record — the hand, into her vault, without a model', () => {
  it('keeps the hand as her seat saw it and folds the counts, from nothing', () => {
    const r = recordHand(null, 'poker.record', hand(1));
    expect(r && isHandRecord(r)).toBe(true);
    expect(r!.hands).toBe(1);
    expect(r!.recent[0]).toMatchObject({ handNo: 1, table: 't1', seat: 0, net: 12 });
    expect(r!.recent[0]!.view).toEqual(hand(1).view);
    expect(r!.memory.rounds).toBe(1);
    expect(r!.memory.subjects['agent:sharkbot.svc']!.counters.cbet).toBe(1);
    expect(r!.memory.subjects.me!.you).toBe(true);
  });

  it('adds to what is there, records the same hand once, and keeps the most recent whole', () => {
    let rec = recordHand(null, 'poker.record', hand(1))!;
    rec = recordHand(rec, 'poker.record', hand(2))!;
    rec = recordHand(rec, 'poker.record', hand(2))!; // a retry
    expect(rec.hands).toBe(2);
    expect(rec.memory.subjects['agent:sharkbot.svc']!.rounds).toBe(2);
    for (let n = 3; n <= HANDS_KEPT + 5; n++) rec = recordHand(rec, 'poker.record', hand(n))!;
    expect(rec.hands).toBe(HANDS_KEPT + 5);
    expect(rec.recent).toHaveLength(HANDS_KEPT);
    expect(rec.recent[0]!.handNo).toBe(6);
    expect(rec.memory.rounds).toBe(HANDS_KEPT + 5); // the counts carry every hand
  });

  it('records nothing from a message with no view, and a record is data — no model is involved', () => {
    expect(recordHand(null, 'poker.record', { handNo: 3 })).toBeNull();
    // The whole module is pure: nothing in it takes a model call.
    expect(String(recordHand.toString())).not.toMatch(/call\(/);
  });
});

describe('the study, as the coach is handed it', () => {
  const access = { owner: ALICE, delegate: COACH, hash: '0x', reads: ['cardroom.hand', 'cardroom.style', 'cardroom.read', 'cardroom.note'], appends: ['cardroom.note'] };
  const rec = [1, 2, 3].reduce((acc, n) => recordHand(acc, 'poker.record', hand(n))!, null as ReturnType<typeof recordHand>);

  it('is her style, the players present in THIS material with rates, her reads, the coach\'s recent notes', () => {
    const s = studyFrom({
      access, hand: rec, style: { rules: ['never limp', 'price first'] }, read: { reads: [{ about: 'Sharkbot', note: 'his turn bet is real', at: 'x' }] },
      note: appendNote(null, { by: 'bob-coach.svc', at: '2026-09-11T00:00:00Z', text: 'called a turn barrel at 43% with 18% — a fold saved 18.' }),
      material: { seat: 0, view: { seats: [{ playerId: 'agent:sharkbot.svc' }, { playerId: 'me' }] } },
    });
    expect(s.style).toEqual(['never limp', 'price first']);
    expect(s.hands).toBe(3);
    expect(s.remembered.map((r) => r.id).sort()).toEqual(['agent:sharkbot.svc', 'me']);
    expect(s.remembered.find((r) => r.id === 'agent:sharkbot.svc')!.rates.cbet).toBe('100% of 3');
    expect(s.reads[0]!.about).toBe('Sharkbot');
    expect(s.notes[0]!.by).toBe('bob-coach.svc');
    expect(s.recent).toBeUndefined(); // a consultation is not handed the hands themselves
    expect(studyFrom({ access, hand: rec, style: null, read: null, note: null, material: {}, review: true }).recent).toHaveLength(3);
  });

  it('reads only what the grant covers', () => {
    const narrow = { ...access, reads: ['cardroom.hand'] };
    const s = studyFrom({ access: narrow, hand: rec, style: { rules: ['never limp'] }, read: { reads: [{ about: 'x', note: 'y', at: 'z' }] }, note: appendNote(null, { by: 'b', at: 'a', text: 't' }), material: {} });
    expect(s.style).toEqual([]);
    expect(s.reads).toEqual([]);
    expect(s.notes).toEqual([]);
    expect(s.hands).toBe(3);
  });

  it('scopes a review by the question: a day, the session, one hand, or the recent hands', () => {
    const at = (iso: string) => ({ handNo: 1, table: 't', seat: 0, at: iso, view: {} });
    const recent = [at('2026-09-10T20:00:00Z'), at('2026-09-11T20:00:00Z'), at('2026-09-11T21:00:00Z')]; // Thu, Fri, Fri
    expect(reviewScopeOf('how did Thursday go?', recent).hands).toHaveLength(1);
    expect(reviewScopeOf('how did Friday go', recent).label).toBe('Friday, 2 hands');
    expect(reviewScopeOf('was I right in that last hand', recent).hands).toHaveLength(1);
    expect(reviewScopeOf('what are my leaks', recent).label).toBe('the last 3 hands');
    expect(reviewScopeOf('how did this session go', recent, new Date('2026-09-11T22:00:00Z')).hands).toHaveLength(2);
  });

  it('a note is appended to her cabinet, bounded, newest last', () => {
    let notes = appendNote(null, { by: 'bob-coach.svc', at: '1', text: 'one' });
    notes = appendNote(notes, { by: 'bob-coach.svc', at: '2', text: 'two' });
    expect(notes.entries.map((n) => n.text)).toEqual(['one', 'two']);
    expect(NOTE_RECORD).toBe('cardroom.note');
    expect(HAND_RECORD).toBe('cardroom.hand');
  });
});

describe('playbook.answer on the coach service, under her grant', () => {
  const material = { skill: 'poker.advise', input: { seat: 0, handNo: 9, view: { seats: [{ playerId: 'agent:sharkbot.svc' }, { playerId: 'me' }] }, legal: { fold: true, call: 18 }, read: { street: 'turn', priceToCall: '43%' } }, question: 'call?' };
  const rec = [1, 2, 3].reduce((acc, n) => recordHand(acc, 'poker.record', hand(n))!, null as ReturnType<typeof recordHand>);
  const study = (notes: Array<{ text: string }> = []) => {
    const loaded = studyFrom({ access: { owner: ALICE, delegate: COACH, hash: '0x', reads: ['cardroom.hand', 'cardroom.style', 'cardroom.read', 'cardroom.note'], appends: ['cardroom.note'] }, hand: rec, style: { rules: ['never call a river bet out of position'] }, read: null, note: { entries: notes.map((n) => ({ by: 'bob-coach.svc', at: '2026-09-01T00:00:00Z', text: n.text })) }, material: material.input, review: true });
    return { load: async () => loaded, coach: COACH, note: async (text: string, extra?: { hand?: number; scope?: string }) => { notes.push({ text: `${text}${extra?.hand ? ` [hand ${extra.hand}]` : ''}${extra?.scope ? ` [${extra.scope}]` : ''}` }); return { ok: true }; } };
  };
  const fakeCall = (reply: Record<string, unknown>) => {
    const seen: Array<{ system: string; user: string; tool: string }> = [];
    const call = async (input: { system: string; messages: Array<{ content: string }>; tool: { name: string } }) => { seen.push({ system: input.system, user: input.messages[0]!.content, tool: input.tool.name }); return reply; };
    return { call, seen };
  };

  it('advises from HER records — style, counts on the players here, notes — in the coach\'s name, and may leave one note', async () => {
    const notes: Array<{ text: string }> = [{ text: 'folds turns too often' }];
    const { call, seen } = fakeCall({ say: 'You need 43% and have 18% — fold.', because: 'He has bet the flop after raising 3 of 3.', action: { type: 'fold' }, note: 'Turn: 43% price, 18% draw, fold.' });
    const invoke = playbookAnswerInvoker({ call, material, advertised: ['poker.advise'], agentName: 'bob-coach.svc', study: study(notes) });
    const out = (await invoke(PLAYBOOK_ANSWER_TOOL.id, { skill: 'poker.advise', question: 'call?' }, ctx)) as Record<string, unknown>;
    expect(out.say).toBe('You need 43% and have 18% — fold.');
    expect(out.source).toBe('bob-coach.svc');
    expect(seen[0]!.user).toContain('Her style');
    expect(seen[0]!.user).toContain('never call a river bet out of position');
    expect(seen[0]!.user).toContain('Her records');
    expect(seen[0]!.user).toContain('"cbet":"100% of 3"');
    expect(seen[0]!.user).toContain('folds turns too often');
    expect(seen[0]!.system).toContain('her style beats your craft');
    // The note went into HER cabinet, with the hand it is about.
    expect(notes.map((n) => n.text)).toContain('Turn: 43% price, 18% draw, fold. [hand 9]');
    expect((out.study as { noted: boolean }).noted).toBe(true);
    expect(JSON.parse(String(out.answer))).toEqual({ say: 'You need 43% and have 18% — fold.', because: 'He has bet the flop after raising 3 of 3.', action: { type: 'fold' } });
  });

  it('reviews her hands when she asks — the scope counted, the note written back — and never without a grant', async () => {
    const notes: Array<{ text: string }> = [];
    const { call, seen } = fakeCall({ say: 'Three hands: up 16. You bet the flop every time you raised.', because: 'Check one flop out of position next session.', note: '3 hands; cbet 3 of 3; check one flop.' });
    const invoke = playbookAnswerInvoker({ call, material: { ...material, skill: 'poker.review', question: 'what are my leaks?' }, advertised: ['poker.review'], agentName: 'bob-coach.svc', study: study(notes) });
    const out = (await invoke(PLAYBOOK_ANSWER_TOOL.id, { skill: 'poker.review', question: 'what are my leaks?' }, ctx)) as Record<string, unknown>;
    expect(out.refused).toBeUndefined();
    expect(out.hands).toBe(3);
    expect(out.scope).toBe('the last 3 hands');
    expect(seen[0]!.tool).toBe('review');
    expect(seen[0]!.system).toContain('Say the sample size in the first sentence');
    expect(seen[0]!.user).toContain('The hands in scope');
    expect(seen[0]!.user).toContain('"hand":3');
    expect(notes[0]!.text).toBe('3 hands; cbet 3 of 3; check one flop. [the last 3 hands]');
    expect(JSON.parse(String(out.answer)).say).toContain('Three hands');
    // No grant ⇒ no records ⇒ no review, and no model call.
    const bare = fakeCall({ say: 'x' });
    const noGrant = playbookAnswerInvoker({ call: bare.call, material: { ...material, skill: 'poker.review' }, advertised: ['poker.review'], agentName: 'alice.me' });
    expect(await noGrant(PLAYBOOK_ANSWER_TOOL.id, { skill: 'poker.review' }, ctx)).toEqual({ refused: 'a review reads her hand records under her study grant, and none was presented' });
    expect(bare.seen).toHaveLength(0);
  });

  it('a review with nothing recorded says so in one sentence, without a model', async () => {
    const { call, seen } = fakeCall({ say: 'x' });
    const empty = { load: async () => studyFrom({ access: { owner: ALICE, delegate: COACH, hash: '0x', reads: ['cardroom.hand'], appends: [] }, hand: null, style: null, read: null, note: null, material: {}, review: true }), coach: COACH };
    const invoke = playbookAnswerInvoker({ call, material: { ...material, skill: 'poker.review' }, advertised: ['poker.review'], agentName: 'bob-coach.svc', study: empty });
    const out = (await invoke(PLAYBOOK_ANSWER_TOOL.id, { skill: 'poker.review' }, ctx)) as Record<string, unknown>;
    expect(String(out.say)).toContain('no recorded hands');
    expect(seen).toHaveLength(0);
  });

  it('a record on the coach is still no model: counts fold, nothing is asked', async () => {
    const { call, seen } = fakeCall({ say: 'x' });
    const invoke = playbookAnswerInvoker({ call, material: { ...material, skill: 'poker.record', input: hand(4) }, advertised: ['poker.record'], agentName: 'bob-coach.svc' });
    const out = (await invoke(PLAYBOOK_ANSWER_TOOL.id, { skill: 'poker.record' }, ctx)) as Record<string, unknown>;
    expect(out.kept).toBe(false); // no memory wired here; the point is the model was never called
    expect(seen).toHaveLength(0);
  });
});

describe('the turn — who talks to whom, and what never happens', () => {
  const grant = { wire: grantWire(), hash: '0xg', delegate: COACH };
  /** A fake Worker: what was consulted, what was written, whether any model was reached. */
  function world(o: { specialists?: Array<{ capability: string; executor: string }> | null; grant?: typeof grant | null; coachReply?: { kind: string; text?: string; error?: string }; verify?: boolean; slow?: boolean; records?: Record<string, unknown> } = {}) {
    const consults: Array<{ agent: string; addressee: string; material: Record<string, unknown> }> = [];
    const writes: Array<{ owner: string; recordType: string; record: unknown }> = [];
    const records: Record<string, unknown> = o.records ?? {};
    let models = 0;
    const deps = {
      nameOf: async (a: string) => (a === ALICE ? 'alice.me' : a === COACH ? 'bob-coach.svc' : a === BOB ? 'bob.me' : null),
      resolveName: async (n: string) => (n === 'bob-coach.svc' ? COACH : n === 'bob.me' ? BOB : null),
      readRecord: async (owner: string, recordType: string) => records[`${owner}:${recordType}`] ?? null,
      writeRecord: async (owner: string, recordType: string, record: unknown) => { writes.push({ owner, recordType, record }); records[`${owner}:${recordType}`] = record; return { ok: true }; },
      specialistsOf: async () => o.specialists === undefined ? [{ capability: 'poker.advise', executor: 'bob-coach.svc' }] : o.specialists,
      studyGrantWire: async () => (o.grant === undefined ? grant : o.grant),
      verify: async (g: { hash: string }, delegator: string, delegate: string) => (o.verify === false ? { ok: false as const, reason: 'the study grant is expired, revoked or not genuinely signed' } : { ok: true as const, access: { owner: delegator, delegate, hash: g.hash, reads: ['cardroom.hand'], appends: ['cardroom.note'] } }),
      consult: async (c: { agent: string; addressee: string; material: Record<string, unknown> }) => {
        consults.push(c); models += 1; // the coach's run is where the model lives
        if (o.slow) await new Promise((r) => setTimeout(r, 50));
        return { reply: o.coachReply ?? { kind: 'answer', text: JSON.stringify({ say: 'Fold.', because: '43% for 18%.', action: { type: 'fold' } }) } };
      },
      timeoutMs: 20,
      log: () => undefined,
    };
    return { deps, consults, writes, records, models: () => models };
  }
  const table = (skill: string, input: Record<string, unknown> = {}) => ({ agent: '0x' + 'e'.repeat(40), addressee: ALICE, ask: `${skill}: advise seat 0`, runRef: 'svc-1', skill, act: cardRoomActOf(skill)!, advertised: true, material: { skill, input: { seat: 0, view: {}, legal: {}, ...input } } });

  it('poker.advise on the PERSON\'s agent consults the coach service with the SAME payload plus the grant — no model of its own', async () => {
    const w = world();
    const out = await cardRoomTurn(w.deps, table('poker.advise', { question: 'call?' }));
    expect(out).toMatchObject({ kind: 'answer' });
    expect(JSON.parse((out as { text: string }).text)).toEqual({ say: 'Fold.', because: '43% for 18%.', action: { type: 'fold' }, source: 'bob-coach.svc' });
    expect(w.consults).toHaveLength(1);
    expect(w.consults[0]!.agent).toBe(ALICE);                   // the person's agent asks
    expect(w.consults[0]!.addressee).toBe(COACH);               // the SERVICE answers, never bob.me
    expect(w.consults[0]!.material.input).toEqual({ seat: 0, view: {}, legal: {}, question: 'call?' }); // unchanged
    expect((w.consults[0]!.material.grant as { hash: string }).hash).toBe('0xg');
    expect(w.consults[0]!.material.onBehalfOf).toBe('alice.me');
    // Her records did NOT travel in the message: the coach reads them under the grant, at her vault.
    expect(JSON.stringify(w.consults[0]!.material)).not.toContain('cardroom.hand');
    expect(w.writes).toHaveLength(0);
  });

  it('refuses in one line — and the house answers — when no coach is named, the coach is a person, the grant is missing, or the coach is late', async () => {
    const refused = async (w: ReturnType<typeof world>, skill = 'poker.advise') => { const o = await cardRoomTurn(w.deps, table(skill)); expect(o).toMatchObject({ kind: 'refused' }); expect(w.consults).toHaveLength(0); return (o as { text: string }).text; };
    expect(await refused(world({ specialists: null }))).toBe('no coach is named for poker.advise; the house coach will answer');
    expect(await refused(world({ specialists: [] }))).toBe('no coach is named for poker.advise; the house coach will answer');
    expect(await refused(world({ specialists: [{ capability: 'poker.advise', executor: 'bob.me' }] }))).toBe('bob.me is not a coaching service; a coach is a service, never a person');
    expect(await refused(world({ grant: null }))).toBe('no study grant for bob-coach.svc; the house coach will answer');
    expect(await refused(world({ grant: { ...grant, delegate: BOB } }))).toBe('the study grant for bob-coach.svc names a different agent');
    const late = world({ slow: true });
    const o = await cardRoomTurn(late.deps, table('poker.advise'));
    expect(o).toMatchObject({ kind: 'refused', text: 'bob-coach.svc did not answer within 0 s' });
    const coachRefused = world({ coachReply: { kind: 'refused', error: 'the study grant is expired, revoked or not genuinely signed' } });
    expect((await cardRoomTurn(coachRefused.deps, table('poker.advise')) as { text: string }).text).toBe('bob-coach.svc: the study grant is expired, revoked or not genuinely signed');
    // An unadvertised skill is refused before anything is looked up.
    const w = world();
    expect(await cardRoomTurn(w.deps, { ...table('poker.advise'), advertised: false })).toMatchObject({ kind: 'refused', text: 'alice.me does not advertise poker.advise' });
  });

  it('poker.record is a vault put on the PERSON\'s agent: no model, no consultation, nothing sent to the coach', async () => {
    const w = world();
    const out = await cardRoomTurn(w.deps, table('poker.record', hand(7)));
    expect(out).toMatchObject({ kind: 'answer', extra: { hands: 1 } });
    expect(JSON.parse((out as { text: string }).text).say).toBe('Recorded hand 7 — 1 on record.');
    expect(w.consults).toHaveLength(0);          // hand end never messages the coach
    expect(w.models()).toBe(0);                  // poker.record does not call a completion API
    expect(w.writes).toEqual([expect.objectContaining({ owner: ALICE, recordType: 'cardroom.hand' })]);
    // Twice more: the record grows in HER vault.
    await cardRoomTurn(w.deps, table('poker.record', hand(8)));
    const rec = w.records[`${ALICE}:cardroom.hand`] as { hands: number };
    expect(rec.hands).toBe(2);
  });

  it('poker.review on the PERSON\'s agent is forwarded to the same coach as advice, with the grant', async () => {
    const w = world({ coachReply: { kind: 'answer', text: JSON.stringify({ say: 'Forty-one hands, down 60.', because: 'Fold the blinds to a raise.' }) } });
    const out = await cardRoomTurn(w.deps, { ...table('poker.review', { question: 'how did Thursday go?' }), ask: 'how did Thursday go?' });
    expect(JSON.parse((out as { text: string }).text)).toEqual({ say: 'Forty-one hands, down 60.', because: 'Fold the blinds to a raise.', source: 'bob-coach.svc' });
    expect(w.consults[0]!.addressee).toBe(COACH);
  });

  it('on the COACH, a presented grant is verified and handed to the harness; a bad one is a one-line refusal; a record is never the coach\'s', async () => {
    const w = world();
    const consultation = { agent: ALICE, addressee: COACH, ask: 'poker.advise: advise seat 0', runRef: 'svc-1/consult', skill: 'poker.advise', act: 'advise' as const, advertised: true, material: { skill: 'poker.advise', input: { seat: 0 }, grant: { wire: grantWire(), hash: '0xg' } } };
    const out = await cardRoomTurn(w.deps, consultation);
    expect(out).toEqual({ study: { owner: ALICE, delegate: COACH, hash: '0xg', reads: ['cardroom.hand'], appends: ['cardroom.note'] } });
    expect(w.consults).toHaveLength(0); // the coach consults nobody further
    const bad = world({ verify: false });
    expect(await cardRoomTurn(bad.deps, consultation)).toMatchObject({ kind: 'refused', text: 'the study grant is expired, revoked or not genuinely signed' });
    expect(await cardRoomTurn(w.deps, { ...consultation, skill: 'poker.record', act: 'record', material: { ...consultation.material, skill: 'poker.record' } })).toMatchObject({ kind: 'refused', text: "a hand is recorded by the person's own agent, never by a coach" });
  });

  it('two seats are two grants: each person\'s agent presents its own, and one is never used for the other', async () => {
    const seen: string[] = [];
    const w = world();
    w.deps.studyGrantWire = async (person: string) => { seen.push(person); return { ...grant, hash: `0x${person.slice(2, 6)}` }; };
    await cardRoomTurn(w.deps, table('poker.advise'));
    await cardRoomTurn(w.deps, { ...table('poker.advise'), addressee: BOB });
    expect(seen).toEqual([ALICE, BOB]);
    expect((w.consults[0]!.material.grant as { hash: string }).hash).toBe('0xaaaa');
    expect((w.consults[1]!.material.grant as { hash: string }).hash).toBe('0xbbbb');
  });
});
