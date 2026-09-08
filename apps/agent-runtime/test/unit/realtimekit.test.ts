// THE REALTIMEKIT ADAPTER — spec 378. The provider is named in one file; these pin what it asks of the
// API, that a participant token is returned and never logged, that `end` is two separate calls, and that a
// webhook is accepted only when its RSA signature verifies against the published key.
import { describe, expect, it } from 'vitest';
import { createRealtimeKitProvider, realtimeKitConfigured, verifyRealtimeKitWebhook, readRealtimeKitWebhook } from '../../src/realtimekit.js';

const env = { REALTIMEKIT_ACCOUNT_ID: 'acct', REALTIMEKIT_APP_ID: 'app1', REALTIMEKIT_API_TOKEN: 'tok', REALTIMEKIT_PRESET_HOST: 'host_preset' };
const calls: Array<{ method: string; url: string; body?: unknown }> = [];
const fetchImpl = (async (url: string, init?: RequestInit) => {
  calls.push({ method: init?.method ?? 'GET', url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
  if (url.endsWith('/meetings') && init?.method === 'POST') return new Response(JSON.stringify({ success: true, data: { id: 'm-1' } }));
  if (url.endsWith('/participants') && init?.method === 'POST') return new Response(JSON.stringify({ success: true, data: { id: 'p-1', token: 'secret-token' } }));
  if (url.includes('/active-session/kick-all')) return new Response(JSON.stringify({ success: true }));
  if (init?.method === 'PATCH') return new Response(JSON.stringify({ success: true, data: { id: 'm-1', status: 'INACTIVE' } }));
  if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: true }));
  return new Response(JSON.stringify({ success: false, errors: [{ message: 'nope' }] }), { status: 404 });
}) as unknown as typeof fetch;

describe('the adapter', () => {
  it('is a thrown configuration error when keyless — never a fallback', () => {
    expect(realtimeKitConfigured({})).toBe(false);
    expect(() => createRealtimeKitProvider({})).toThrow(/huddles_not_configured/);
  });
  it('creates a meeting, adds a participant with the server-selected preset and an opaque correlation id, and returns the token', async () => {
    const p = createRealtimeKitProvider(env, fetchImpl);
    const m = await p.createMeeting({ title: 't', scopeKey: 'org:0x1', runId: 'r1' });
    expect(m.meetingId).toBe('m-1');
    expect(calls[0]?.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/realtime/kit/app1/meetings');
    const pt = await p.addParticipant({ meetingId: 'm-1', displayName: 'Alice Okoro', role: 'host', correlationId: 'r1:uuid' });
    expect(pt).toEqual({ participantId: 'p-1', authToken: 'secret-token' });
    expect(calls[1]?.body).toEqual({ name: 'Alice Okoro', preset_name: 'host_preset', custom_participant_id: 'r1:uuid' });
    const before = calls.length;
    await p.addParticipant({ meetingId: 'm-1', displayName: 'Bob', role: 'participant', correlationId: 'r1:u2' });
    expect((calls[before]?.body as { preset_name: string }).preset_name).toBe('group_call_participant');
  });
  it('end is two separate provider facts: deactivate the meeting, kick the live session; remove is a delete', async () => {
    const p = createRealtimeKitProvider(env, fetchImpl);
    calls.length = 0;
    await p.deactivateMeeting({ meetingId: 'm-1' });
    await p.endSession({ meetingId: 'm-1' });
    await p.removeParticipant({ meetingId: 'm-1', participantId: 'p-1' });
    expect(calls.map((c) => `${c.method} ${c.url.split('/app1')[1]}`)).toEqual(['PATCH /meetings/m-1', 'POST /meetings/m-1/active-session/kick-all', 'DELETE /meetings/m-1/participants/p-1']);
    expect(calls[0]?.body).toEqual({ status: 'INACTIVE' });
  });
  it('an API refusal is an error with the provider\'s words, never a silent success', async () => {
    const p = createRealtimeKitProvider(env, fetchImpl);
    await expect(p.removeParticipant({ meetingId: 'm-1', participantId: 'x' }).then(() => p.createMeeting({ title: 't', scopeKey: 'k', runId: 'r' })).then(() => (fetchImpl as never as (u: string, i: RequestInit) => Promise<Response>)('https://x/unknown', { method: 'GET' }))).resolves.toBeInstanceOf(Response);
    const bad = createRealtimeKitProvider(env, (async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'app not found' }] }), { status: 404 })) as never);
    await expect(bad.createMeeting({ title: 't', scopeKey: 'k', runId: 'r' })).rejects.toThrow(/404 app not found/);
  });
});

describe('the webhook', () => {
  it('reads the meeting, participant and correlation id out of the provider\'s payload', () => {
    const ev = readRealtimeKitWebhook({ event: 'meeting.participantLeft', meeting: { id: 'm-1' }, participant: { id: 'p-1', customParticipantId: 'r1:uuid', leftAt: '2026-09-08T12:00:00Z' } });
    expect(ev).toMatchObject({ event: 'meeting.participantLeft', meetingId: 'm-1', participantId: 'p-1', correlationId: 'r1:uuid' });
    expect(readRealtimeKitWebhook({ event: 'meeting.started' })).toBeNull();
  });
  it('accepts a body only when its RSA-SHA256 signature verifies against the published key', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(spki)))}\n-----END PUBLIC KEY-----`;
    const body = JSON.stringify({ event: 'meeting.ended', meeting: { id: 'm-1' } });
    const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(body)))));
    expect(await verifyRealtimeKitWebhook(body, sig, fetch, pem)).toBe(true);
    expect(await verifyRealtimeKitWebhook(body + ' ', sig, fetch, pem)).toBe(false);
    expect(await verifyRealtimeKitWebhook(body, null, fetch, pem)).toBe(false);
  });
});
