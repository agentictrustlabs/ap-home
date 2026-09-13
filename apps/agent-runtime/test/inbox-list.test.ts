// messaging.inbox.list — the agent's own inbox since a cursor (spec 400 W1). The subject is the run's agent, never an
// argument; bodies are read from its own vault; a cursor that is neither a held id nor a moment is refused.
import { describe, it, expect } from 'vitest';
import { inboxListInvoker } from '../src/inbox-list.js';

const ME = '0x00000000000000000000000000000000000000aa';
const MARA = '0x00000000000000000000000000000000000000bb';
const env = (id: string, from: string, at: string, text: string) => ({ id, conversationId: 'dm:1', from: `eip155:34348:${from}`, to: [`eip155:34348:${ME}`], createdAt: at, body: { resource: `vault:message.body:dm:${id}` } });
const records: Record<string, unknown> = {
  'inbox.data': { envelopes: [env('m3', MARA, '2026-09-13T10:00:03Z', 'third'), env('m1', MARA, '2026-09-13T10:00:01Z', 'first'), env('m2', ME, '2026-09-13T10:00:02Z', 'my reply')] },
  'message.body:dm:m1': { b64: Buffer.from('first', 'utf8').toString('base64') },
  'message.body:dm:m2': { b64: Buffer.from('my reply', 'utf8').toString('base64') },
  'message.body:dm:m3': { b64: Buffer.from('third', 'utf8').toString('base64') },
};
const reads: string[] = [];
const deps = {
  readSubjectRecord: async (subject: string, type: string) => { reads.push(`${subject}:${type}`); if (subject !== ME) throw new Error('not yours'); return records[type] ?? null; },
  nameOf: async (a: string) => (a === MARA ? 'mara.me' : null),
};
const ctx = {} as never;

describe('messaging.inbox.list', () => {
  it('lists the agent\'s own inbox oldest→newest with bodies and names, and hands back the newest id as the cursor', async () => {
    const out = (await inboxListInvoker(deps, ME)('messaging.inbox.list', {}, ctx)) as { messages: Array<{ id: string; text: string; fromName: string | null; mine: boolean }>; cursor: string; count: number };
    expect(out.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(out.messages[0]).toMatchObject({ text: 'first', fromName: 'mara.me', mine: false });
    expect(out.messages[1]).toMatchObject({ text: 'my reply', mine: true });
    expect(out.cursor).toBe('m3');
    expect(reads.every((r) => r.startsWith(`${ME}:`))).toBe(true);
  });
  it('a cursor by id lists only what came after; a cursor by moment likewise; nothing new says so', async () => {
    const byId = (await inboxListInvoker(deps, ME)('messaging.inbox.list', { since: 'm1' }, ctx)) as { messages: Array<{ id: string }>; cursor: string };
    expect(byId.messages.map((m) => m.id)).toEqual(['m2', 'm3']);
    const byTime = (await inboxListInvoker(deps, ME)('messaging.inbox.list', { since: '2026-09-13T10:00:02Z' }, ctx)) as { messages: Array<{ id: string }> };
    expect(byTime.messages.map((m) => m.id)).toEqual(['m3']);
    const none = (await inboxListInvoker(deps, ME)('messaging.inbox.list', { since: 'm3' }, ctx)) as { count: number; cursor: string; note: string };
    expect(none.count).toBe(0); expect(none.cursor).toBe('m3'); expect(none.note).toMatch(/Nothing new/);
  });
  it('refuses a cursor that is neither a held id nor a moment, and refuses with no agent on the run', async () => {
    expect(await inboxListInvoker(deps, ME)('messaging.inbox.list', { since: 'yesterday-ish' }, ctx)).toMatchObject({ refused: expect.stringMatching(/neither/) });
    expect(await inboxListInvoker(deps, undefined)('messaging.inbox.list', {}, ctx)).toMatchObject({ refused: expect.stringMatching(/no agent/) });
  });
});
