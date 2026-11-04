import { describe, it, expect } from 'vitest';
import { faithInvoker, FAITH_JOURNEY_GET, FAITH_JOURNEY_RECORD, FAITH_PRAYERS_LIST, FAITH_PRAYER_SAVE, FAITH_CARE_REQUEST, FAITH_SHARED_VIEW, FAITH_CLASS } from '../src/faith-records.js';

const ALICE = '0x' + 'a'.repeat(40);
const CHURCH = '0x' + 'c'.repeat(40);
const OTHER_CHURCH = '0x' + 'd'.repeat(40);
const BOB = '0x' + 'b'.repeat(40);

function vault(opts: { denyWrites?: boolean } = {}) {
  const rows = new Map<string, unknown>();
  const k = (s: string, t: string) => `${s.toLowerCase()}|${t}`;
  return {
    rows,
    survey: async (s: string) => [...rows.keys()].filter((x) => x.startsWith(`${s.toLowerCase()}|`)).map((x) => ({ recordType: x.split('|')[1]! })),
    readRecords: async (s: string, keys: string[]) => Object.fromEntries(keys.map((t) => [t, rows.get(k(s, t))])),
    readSubjectRecord: async (s: string, t: string) => rows.get(k(s, t)) ?? null,
    writeSubjectRecord: async (s: string, t: string, r: unknown) => {
      if (opts.denyWrites) return { ok: false, error: 'record_scope_denied: vault:faith.prayer-request:x' };
      rows.set(k(s, t), r);
      return { ok: true };
    },
  };
}
const turn = (goal = 'x', context: Record<string, unknown> = {}) => ({ intent: { goal, context }, step: { id: 's0' }, index: 0, supplied: [] }) as never;
const at = (iso: string) => () => new Date(iso);

describe('the person\'s own faith records', () => {
  it('a new prayer is Confidential: hers to list, and no audience sees it', async () => {
    const v = vault();
    const inv = faithInvoker(v, ALICE, ALICE);
    const saved = (await inv(FAITH_PRAYER_SAVE, { label: "Mom's surgery", prayingFor: 'my mom' }, turn())) as { saved: { id: string; visibility: string; status: string }; answer: string };
    expect(saved.saved).toMatchObject({ visibility: 'Confidential', status: 'expressed' });
    expect(saved.answer).toMatch(/only you can see it/);
    const stored = v.rows.get(`${ALICE}|faith.prayer-request:${saved.saved.id}`) as Record<string, unknown>;
    expect(stored['@type']).toBe(FAITH_CLASS.prayer);
    expect(stored).toMatchObject({ aboutSubject: ALICE, label: "Mom's surgery", kind: 'Request', prayingFor: 'my mom' });
    const mine = (await inv(FAITH_PRAYERS_LIST, {}, turn())) as { prayers: Array<{ label: string }> };
    expect(mine.prayers.map((p) => p.label)).toEqual(["Mom's surgery"]);
    for (const audience of ['friends', 'church', 'leaders']) {
      const view = (await inv(FAITH_SHARED_VIEW, { audience, church: CHURCH, purpose: 'faith-ask' }, turn())) as { prayers: unknown[]; withheld: number };
      expect(view.prayers).toEqual([]);
      expect(view.withheld).toBe(1);
    }
  });

  it('BodyOnly reaches the named church only; LeadersOnly reaches only that church\'s leaders', async () => {
    const v = vault();
    const inv = faithInvoker(v, ALICE, ALICE);
    await inv(FAITH_PRAYER_SAVE, { label: 'New job', visibility: 'BodyOnly', sharedWith: CHURCH }, turn());
    await inv(FAITH_PRAYER_SAVE, { label: 'My marriage', visibility: 'LeadersOnly', sharedWith: CHURCH }, turn());
    const labels = async (audience: string, church: string) => ((await inv(FAITH_SHARED_VIEW, { audience, church, purpose: 'faith-ask' }, turn())) as { prayers: Array<{ label: string }> }).prayers.map((p) => p.label).sort();
    expect(await labels('church', CHURCH)).toEqual(['New job']);
    expect(await labels('leaders', CHURCH)).toEqual(['My marriage', 'New job']);
    expect(await labels('church', OTHER_CHURCH)).toEqual([]);
    expect(await labels('leaders', OTHER_CHURCH)).toEqual([]);
    expect(((await inv(FAITH_SHARED_VIEW, { audience: 'friends', purpose: 'x' }, turn())) as { prayers: unknown[] }).prayers).toEqual([]);
  });

  it('Friends reaches every friend, or only the friends it names', async () => {
    const v = vault();
    const inv = faithInvoker(v, ALICE, ALICE);
    await inv(FAITH_PRAYER_SAVE, { label: 'For all friends', visibility: 'Friends' }, turn());
    await inv(FAITH_PRAYER_SAVE, { label: 'Only Bob', visibility: 'Friends', sharedWith: BOB }, turn());
    const seen = async (friend?: string) => ((await inv(FAITH_SHARED_VIEW, { audience: 'friends', ...(friend ? { friend } : {}), purpose: 'x' }, turn())) as { prayers: Array<{ label: string }> }).prayers.map((p) => p.label).sort();
    expect(await seen(BOB)).toEqual(['For all friends', 'Only Bob']);
    expect(await seen('0x' + 'e'.repeat(40))).toEqual(['For all friends']);
    expect(await seen()).toEqual(['For all friends']);
    expect(((await inv(FAITH_SHARED_VIEW, { audience: 'church', church: CHURCH, purpose: 'x' }, turn())) as { prayers: unknown[] }).prayers).toEqual([]);
  });

  it('prayed counts; answered keeps a report in her words and moves the status', async () => {
    const v = vault();
    const inv = faithInvoker({ ...v, now: at('2026-11-03T10:00:00Z') }, ALICE, ALICE);
    const { saved } = (await inv(FAITH_PRAYER_SAVE, { label: 'Surgery' }, turn())) as { saved: { id: string } };
    await inv(FAITH_PRAYER_SAVE, { id: saved.id, prayed: 'yes' }, turn());
    const twice = (await inv(FAITH_PRAYER_SAVE, { id: saved.id, prayed: 'yes' }, turn())) as { answer: string };
    expect(twice.answer).toMatch(/Prayed \(2 times\)/);
    await inv(FAITH_PRAYER_SAVE, { id: saved.id, answered: 'The surgery went well' }, turn());
    const list = (await inv(FAITH_PRAYERS_LIST, { status: 'fulfilled' }, turn())) as { prayers: Array<{ status: string; prayedCount: number; answered?: { description: string; answeredAt: string } }> };
    expect(list.prayers).toHaveLength(1);
    expect(list.prayers[0]).toMatchObject({ status: 'fulfilled', prayedCount: 2, answered: { description: 'The surgery went well', answeredAt: '2026-11-03T10:00:00.000Z' } });
    const report = v.rows.get(`${ALICE}|faith.answered-prayer:${saved.id}`) as Record<string, unknown>;
    expect(report['@type']).toBe(FAITH_CLASS.answered);
    expect(report.answers).toBe(`urn:faith:${ALICE}:prayer-request:${saved.id}`);
    expect(((await inv(FAITH_PRAYERS_LIST, { status: 'expressed' }, turn())) as { prayers: unknown[] }).prayers).toEqual([]);
  });

  it('a removed prayer stays as a tombstone and is never listed or shared', async () => {
    const v = vault();
    const inv = faithInvoker(v, ALICE, ALICE);
    const { saved } = (await inv(FAITH_PRAYER_SAVE, { label: 'Gone', visibility: 'Open' }, turn())) as { saved: { id: string } };
    await inv(FAITH_PRAYER_SAVE, { id: saved.id, remove: 'yes' }, turn());
    expect((v.rows.get(`${ALICE}|faith.prayer-request:${saved.id}`) as { removedAt?: string }).removedAt).toBeTruthy();
    expect(((await inv(FAITH_PRAYERS_LIST, {}, turn())) as { prayers: unknown[] }).prayers).toEqual([]);
    expect(((await inv(FAITH_SHARED_VIEW, { audience: 'friends', purpose: 'x' }, turn())) as { prayers: unknown[] }).prayers).toEqual([]);
    expect(await inv(FAITH_PRAYER_SAVE, { id: saved.id, label: 'back?' }, turn())).toMatchObject({ refused: expect.stringMatching(/removed/) });
  });

  it('the journey: a stage is a new assertion each time; next steps come from the next-step graph', async () => {
    const v = vault();
    const day1 = faithInvoker({ ...v, now: at('2026-01-01T00:00:00Z') }, ALICE, ALICE);
    const day2 = faithInvoker({ ...v, now: at('2026-06-01T00:00:00Z') }, ALICE, ALICE);
    await day1(FAITH_JOURNEY_RECORD, { stage: 'Seeker' }, turn());
    await day2(FAITH_JOURNEY_RECORD, { stage: 'new believer', milestone: 'Baptized', occurredOn: '2026-05', place: 'Calvary' }, turn());
    const j = (await day2(FAITH_JOURNEY_GET, {}, turn())) as { stage: { stage: string; visibility: string }; history: unknown[]; milestones: Array<{ milestone: string; occurredOn: string; place: string }>; nextSteps: Array<{ kind: string; value: string; strength: string; forStage: string }> };
    expect(j.stage).toMatchObject({ stage: 'NewBeliever', visibility: 'Confidential' });
    expect(j.history).toHaveLength(2);
    expect(j.milestones).toEqual([expect.objectContaining({ milestone: 'Baptized', occurredOn: '2026-05', place: 'Calvary' })]);
    expect(j.nextSteps.map((s) => `${s.kind}:${s.value}@${s.forStage}`)).toEqual(['practice:Bible@NewBeliever', 'practice:Prayer@NewBeliever', 'milestone:JoinedGroup@Connected']);
    const keys = [...v.rows.keys()].filter((x) => x.includes('faith.journey-stage:'));
    expect(keys).toHaveLength(2);
  });

  it('only the current stage is shared, and only when it is visible to that audience', async () => {
    const v = vault();
    const d1 = faithInvoker({ ...v, now: at('2026-01-01T00:00:00Z') }, ALICE, ALICE);
    const d2 = faithInvoker({ ...v, now: at('2026-02-01T00:00:00Z') }, ALICE, ALICE);
    await d1(FAITH_JOURNEY_RECORD, { stage: 'Seeker', visibility: 'BodyOnly', sharedWith: CHURCH }, turn());
    expect(((await d1(FAITH_SHARED_VIEW, { audience: 'church', church: CHURCH, purpose: 'x' }, turn())) as { stage?: { stage: string } }).stage?.stage).toBe('Seeker');
    await d2(FAITH_JOURNEY_RECORD, { stage: 'Conversion' }, turn());
    const view = (await d2(FAITH_SHARED_VIEW, { audience: 'church', church: CHURCH, purpose: 'x' }, turn())) as { stage?: unknown; nextSteps: unknown[] };
    expect(view.stage).toBeUndefined();
    expect(view.nextSteps).toEqual([]);
  });

  it('a milestone can be removed by its id', async () => {
    const v = vault();
    const inv = faithInvoker(v, ALICE, ALICE);
    const r = (await inv(FAITH_JOURNEY_RECORD, { milestone: 'JoinedGroup' }, turn())) as { recorded: { milestone: { id: string } } };
    await inv(FAITH_JOURNEY_RECORD, { remove: r.recorded.milestone.id }, turn());
    expect(((await inv(FAITH_JOURNEY_GET, {}, turn())) as { milestones: unknown[] }).milestones).toEqual([]);
    expect(await inv(FAITH_JOURNEY_RECORD, { remove: r.recorded.milestone.id }, turn())).toMatchObject({ refused: expect.any(String) });
  });

  it('a care request reaches the named church\'s leaders only, and can be withdrawn', async () => {
    const v = vault();
    const inv = faithInvoker(v, ALICE, ALICE);
    const c = (await inv(FAITH_CARE_REQUEST, { label: 'Please call me', urgency: 'high', safeToText: 'no', church: CHURCH }, turn())) as { saved: { id: string; urgency: string }; answer: string };
    expect(c.saved.urgency).toBe('High');
    expect(c.answer).toMatch(/emergency/);
    expect(((await inv(FAITH_SHARED_VIEW, { audience: 'leaders', church: CHURCH, purpose: 'care' }, turn())) as { care: Array<{ label: string; safeToText: boolean }> }).care).toEqual([expect.objectContaining({ label: 'Please call me', safeToText: false })]);
    expect(((await inv(FAITH_SHARED_VIEW, { audience: 'church', church: CHURCH, purpose: 'care' }, turn())) as { care: unknown[] }).care).toEqual([]);
    expect(((await inv(FAITH_SHARED_VIEW, { audience: 'leaders', church: OTHER_CHURCH, purpose: 'care' }, turn())) as { care: unknown[] }).care).toEqual([]);
    await inv(FAITH_CARE_REQUEST, { id: c.saved.id, withdraw: 'yes' }, turn());
    expect(((await inv(FAITH_PRAYERS_LIST, {}, turn())) as { care: Array<{ status: string }> }).care[0]!.status).toBe('withdrawn');
  });

  it('refuses what is not hers to say, or not hers to ask', async () => {
    const v = vault();
    const inv = faithInvoker(v, ALICE, ALICE);
    expect(await inv(FAITH_JOURNEY_RECORD, { stage: 'Saint' }, turn())).toMatchObject({ refused: expect.stringMatching(/stage/) });
    expect(await inv(FAITH_PRAYER_SAVE, {}, turn())).toMatchObject({ refused: expect.stringMatching(/what the prayer is for/) });
    expect(await faithInvoker(v, ALICE, CHURCH)(FAITH_PRAYERS_LIST, {}, turn())).toMatchObject({ refused: expect.stringMatching(/your own agent/) });
    expect(await inv(FAITH_SHARED_VIEW, { audience: 'church', purpose: 'x' }, turn())).toMatchObject({ refused: expect.stringMatching(/church/) });
    expect(await inv(FAITH_SHARED_VIEW, { audience: 'everyone', purpose: 'x' }, turn())).toMatchObject({ refused: expect.any(String) });
    await expect(inv(FAITH_PRAYER_SAVE, { label: 'x' }, turn('x', { trigger: 'schedule' }))).rejects.toThrow(/your own turn/);
    expect(v.rows.size).toBe(0);
  });

  it('a grant that predates faith records says so instead of failing silently', async () => {
    const inv = faithInvoker(vault({ denyWrites: true }), ALICE, ALICE);
    await expect(inv(FAITH_PRAYER_SAVE, { label: 'x' }, turn())).rejects.toThrow(/storage grant predates faith records/);
  });
});
