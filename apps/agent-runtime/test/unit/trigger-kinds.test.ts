// TRIGGER KINDS — spec 375. Four sources, one rule: a trigger fires a run the agent starts as itself,
// holding nothing. These pin the MATCHING (what fires what) and the door (a webhook without its token
// starts nothing), and that an event reaches the principal and the agent it names — nobody else.
import { describe, expect, it } from 'vitest';
import { schedulesFor, matchingTriggers, dueNow, advanced, triggerContext, fireTriggers, type TriggerScheduleV1 } from '../../src/triggers.js';

const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333';
const rows = schedulesFor(ORG, '0xdigest', [
  { id: 'daily', kind: 'schedule', every: 'PT24H', ask: 'what are we working on' },
  { id: 'on-request', kind: 'event', on: { event: 'EndeavorRequestSubmitted' }, ask: 'what are we working on' },
  { id: 'on-commitment', kind: 'event', on: { event: 'ContributionCommitted' }, ask: 'allocate the contribution just committed' },
  { id: 'status-hook', kind: 'webhook', ask: 'what are we working on' },
  { id: 'on-dm', kind: 'message', on: { profile: 'dm' }, ask: 'draft a reply' },
], 1_000_000);

describe('rows from a playbook', () => {
  it('a schedule keeps its clock; the other kinds have none; a webhook is minted a token', () => {
    expect(rows.find((r) => r.triggerId === 'daily')?.nextAt).toBe(1_000_000 + 24 * 3600_000);
    expect(rows.find((r) => r.triggerId === 'on-request')?.nextAt).toBeUndefined();
    expect(rows.find((r) => r.triggerId === 'status-hook')?.token).toMatch(/^0x[0-9a-f]{48}$/);
    expect(dueNow(rows, 2_000_000_000).map((r) => r.triggerId)).toEqual(['daily']); // the clock fires schedules only
  });
  it('advancing a schedule moves its clock; advancing an event row records the outcome and nothing else', () => {
    const ev = rows.find((r) => r.triggerId === 'on-request')!;
    const a = advanced(ev, 'answered', 'trigger-on-request-1', 'eight members', 5_000);
    expect(a.nextAt).toBeUndefined();
    expect(a).toMatchObject({ lastOutcome: 'answered', lastRunRef: 'trigger-on-request-1', lastSaid: 'eight members' });
  });
});

describe('what fires what', () => {
  it('an event matches by type — and only its type', () => {
    const hit = matchingTriggers(rows, { kind: 'event', event: { type: 'EndeavorRequestSubmitted', endeavorId: 'e1' } });
    expect(hit.map((r) => r.triggerId)).toEqual(['on-request']);
    expect(matchingTriggers(rows, { kind: 'event', event: { type: 'PlanAdopted', endeavorId: 'e1' } })).toEqual([]);
  });
  it('a webhook matches its own row with its own token, and nothing else', () => {
    const token = rows.find((r) => r.triggerId === 'status-hook')!.token!;
    expect(matchingTriggers(rows, { kind: 'webhook', triggerId: 'status-hook', token, payload: {} }).length).toBe(1);
    expect(matchingTriggers(rows, { kind: 'webhook', triggerId: 'status-hook', token: '0xwrong', payload: {} })).toEqual([]);
    expect(matchingTriggers(rows, { kind: 'webhook', triggerId: 'daily', token, payload: {} })).toEqual([]);   // a schedule is not a door
    expect(matchingTriggers(rows, { kind: 'webhook', triggerId: 'on-dm', token, payload: {} })).toEqual([]);
  });
  it('a message matches by profile', () => {
    expect(matchingTriggers(rows, { kind: 'message', message: { id: 'm1', from: ORG, profile: 'dm' } }).map((r) => r.triggerId)).toEqual(['on-dm']);
    expect(matchingTriggers(rows, { kind: 'message', message: { id: 'm1', from: ORG, profile: 'topic-mention' } })).toEqual([]);
  });
  it('the context a fired run receives is the source, whole and public', () => {
    expect(triggerContext({ kind: 'webhook', triggerId: 'x', token: 't', payload: { a: 1 } })).toEqual({ payload: { a: 1 } });
    expect(triggerContext({ kind: 'event', event: { type: 'PlanAdopted', endeavorId: 'e1' } })).toEqual({ event: { type: 'PlanAdopted', endeavorId: 'e1' } });
  });
});

describe('firing', () => {
  const store = (initial: TriggerScheduleV1[]) => {
    const state = new Map(initial.map((r) => [r.triggerId, r]));
    const env = { A2A_INTERNAL_MARKER: 'test-marker-0123456789abcdef0123456789abcdef', A2A_TASKS: { idFromName: () => 'id', get: () => ({ fetch: async (req: Request) => {
      const op = new URL(req.url).pathname.split('/').pop();
      const body = (await req.json()) as { row?: TriggerScheduleV1 };
      if (op === 'trigger-list') return Response.json({ ok: true, rows: [...state.values()] });
      if (op === 'trigger-advance' && body.row) { state.set(body.row.triggerId, body.row); return Response.json({ ok: true }); }
      return Response.json({ ok: false, error: `unexpected ${op}` }, { status: 400 });
    } }) } } as never;
    return { env, state };
  };
  it('fires one unattended run per matching row, records the outcome, and fires nothing for a wrong token', async () => {
    const { env, state } = store(rows);
    const ran: string[] = [];
    const run = async (row: TriggerScheduleV1, runRef: string, context: Record<string, unknown>) => { ran.push(`${row.triggerId}:${JSON.stringify(context)}`); return { outcome: 'answered' as const, said: 'ok', runRef }; };
    const fired = await fireTriggers(env, ORG, { kind: 'event', event: { type: 'EndeavorRequestSubmitted', endeavorId: 'e1' } }, run);
    expect(fired.map((f) => f.triggerId)).toEqual(['on-request']);
    expect(ran).toEqual(['on-request:{"event":{"type":"EndeavorRequestSubmitted","endeavorId":"e1"}}']);
    expect(state.get('on-request')?.lastOutcome).toBe('answered');
    const none = await fireTriggers(env, ORG, { kind: 'webhook', triggerId: 'status-hook', token: '0xwrong', payload: null }, run);
    expect(none).toEqual([]);
    expect(ran.length).toBe(1);
  });
  it('a run that throws is recorded as failed on its row — the trigger is not lost', async () => {
    const { env, state } = store(rows);
    const fired = await fireTriggers(env, ORG, { kind: 'event', event: { type: 'ContributionCommitted', endeavorId: 'e1' } }, async () => { throw new Error('planner down'); });
    expect(fired[0]?.outcome).toBe('failed');
    expect(state.get('on-commitment')?.lastSaid).toBe('planner down');
  });
});
