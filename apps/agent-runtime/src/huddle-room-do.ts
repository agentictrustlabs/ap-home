// THE HUDDLE ROOM — spec 378 §3. One Durable Object per SCOPE KEY, holding the current run.
//
// Serving-plane state (ADR-0055): the run, its provider binding, admission references, idempotency
// keys and deadlines. If this object were wiped, a huddle is a rebuild — the record of what happened is
// the messaging thread and the audit — never a bereavement. It serialises the one race that matters
// (two starts at once resolve to one run), records `creating` BEFORE the provider call, and ends a run
// in the order spec 378 §4 names: ending → deactivate → kick → ended.
//
// It never sees a session: the Worker route verifies the caller and DERIVES their standing at the scope,
// and hands the object `{ actor, standing }`. It never keeps a participant token: the adapter returns one
// and this object returns it once, to the route, to the browser.
import type { Address } from 'viem';
import { applyHuddleEvent, admissionFor, roster, nextDeadline, scopeKey, type HuddleRunV1, type HuddleScopeV1, type ScopeStanding, type MediaProviderPort, type ProviderWebhookEvent } from '@agenticprimitives/collaboration';
import { createRealtimeKitProvider, type RealtimeKitEnv } from './realtimekit.js';
import { isInternalCall, type InternalMarkerEnv } from './internal-marker.js';

export type HuddleDoEnv = RealtimeKitEnv & InternalMarkerEnv & { HUDDLE_MAX_MS?: string; HUDDLE_EMPTY_GRACE_MS?: string; HUDDLE_INVITE_TTL_MS?: string; BRIDGE_NONCES?: KVNamespace };

const RUN_KEY = 'huddle:run';
const POLICY_VERSION = 'spec378-w1';

type Op =
  | { op: 'get'; actor: Address; standing: ScopeStanding }
  | { op: 'start'; actor: Address; standing: ScopeStanding; scope: HuddleScopeV1; displayName: string; represented?: Address; key: string }
  | { op: 'join'; actor: Address; standing: ScopeStanding; displayName: string; represented?: Address; key: string }
  | { op: 'leave'; actor: Address; standing: ScopeStanding; key: string }
  | { op: 'end'; actor: Address; standing: ScopeStanding; key: string }
  | { op: 'invite'; actor: Address; standing: ScopeStanding; invitee: Address; inviteeStanding: ScopeStanding; key: string }
  | { op: 'removeParticipant'; actor: Address; standing: ScopeStanding; target: Address; key: string }
  | { op: 'webhook'; event: ProviderWebhookEvent };

const json = (b: unknown, status = 200) => Response.json(b, { status });
const lc = (a: string) => a.toLowerCase() as Address;

export class HuddleRoomDO {
  private provider: MediaProviderPort | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private state: DurableObjectState, private env: HuddleDoEnv) {}

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
  private media(): MediaProviderPort {
    if (!this.provider) this.provider = createRealtimeKitProvider(this.env);
    return this.provider;
  }
  private async load(): Promise<HuddleRunV1 | null> { return (await this.state.storage.get<HuddleRunV1>(RUN_KEY)) ?? null; }
  private async save(run: HuddleRunV1): Promise<void> {
    await this.state.storage.put(RUN_KEY, run);
    const due = nextDeadline(run, Number(this.env.HUDDLE_EMPTY_GRACE_MS ?? 120_000));
    if (due !== null) { const cur = await this.state.storage.getAlarm(); if (cur === null || cur > due) await this.state.storage.setAlarm(Math.max(due, Date.now() + 1000)); }
  }
  /** What a listing shows: the run without its applied keys — never a credential (there is none here). */
  private view(run: HuddleRunV1 | null) {
    if (!run) return null;
    const { applied: _a, ...rest } = run;
    return { ...rest, roster: roster(run) };
  }

  async fetch(request: Request): Promise<Response> {
    if (!isInternalCall(request, this.env)) return json({ ok: false, error: 'internal only' }, 403);
    const body = (await request.json().catch(() => null)) as Op | null;
    if (!body?.op) return json({ ok: false, error: 'op required' }, 400);
    try {
      return await this.serialize(() => this.handle(body));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({ ok: false, error: msg.startsWith('huddles_not_configured') ? 'huddles_not_configured' : msg }, msg.startsWith('huddles_not_configured') ? 503 : 500);
    }
  }

  private async handle(b: Op): Promise<Response> {
    const now = Date.now();
    let run = await this.load();
    if (b.op === 'webhook') return this.onWebhook(run, b.event);
    if (b.op === 'get') {
      const a = admissionFor('get', { run, actor: b.actor, standing: b.standing, now });
      if (!a.ok) return json({ ok: false, error: a.reason }, 404);
      return json({ ok: true, run: this.view(run && run.state !== 'ended' ? run : null) });
    }
    if (b.op === 'start') {
      // Two starts at once: the second finds the first's run and JOINS the same one (spec 378 §3).
      if (run && run.state === 'active') return this.join({ ...b, op: 'join' }, run, now);
      if (run && run.state !== 'ended') return json({ ok: false, error: `a huddle is ${run.state} here — try again in a moment` }, 409);
      const a = admissionFor('start', { run: null, actor: b.actor, standing: b.standing, now });
      if (!a.ok) return json({ ok: false, error: a.reason }, 403);
      const runId = `huddle-${crypto.randomUUID()}`;
      const started = applyHuddleEvent(run, { type: 'started', runId, scope: b.scope, by: b.actor, at: now, policyVersion: POLICY_VERSION, maxDurationMs: Number(this.env.HUDDLE_MAX_MS ?? 4 * 3600_000), key: b.key });
      if (!started.ok) return json({ ok: false, error: started.reason }, 409);
      // STATE BEFORE SIDE EFFECT: `creating` is persisted first; a provider call that never comes back
      // leaves a run the next `start` refuses for a moment and the alarm cleans up.
      await this.save(started.run);
      let meetingId: string;
      try {
        ({ meetingId } = await this.media().createMeeting({ title: `huddle ${scopeKey(b.scope)}`, scopeKey: scopeKey(b.scope), runId }));
      } catch (e) {
        const ended = applyHuddleEvent(started.run, { type: 'ended', at: Date.now(), key: `${b.key}:abort` });
        if (ended.ok) await this.save(ended.run);
        throw e;
      }
      const bound = applyHuddleEvent(started.run, { type: 'provider-bound', meetingId, at: Date.now(), key: `${b.key}:bind` });
      if (!bound.ok) return json({ ok: false, error: bound.reason }, 500);
      await this.save(bound.run);
      await this.env.BRIDGE_NONCES?.put(`huddle:meeting:${meetingId}`, scopeKey(b.scope), { expirationTtl: 7 * 24 * 3600 }).catch(() => undefined);
      return this.join({ ...b, op: 'join' }, bound.run, now, 'starter');
    }
    if (b.op === 'join') return this.join(b, run, now);
    if (b.op === 'leave') {
      const a = admissionFor('leave', { run, actor: b.actor, standing: b.standing, now });
      if (!a.ok) return json({ ok: false, error: a.reason }, 409);
      const left = applyHuddleEvent(run, { type: 'left', actor: b.actor, at: now, key: b.key });
      if (!left.ok) return json({ ok: false, error: left.reason }, 409);
      await this.save(left.run);
      return json({ ok: true, run: this.view(left.run) });
    }
    if (b.op === 'end') {
      const a = admissionFor('end', { run, actor: b.actor, standing: b.standing, now });
      if (!a.ok) return json({ ok: false, error: a.reason }, 403);
      return json(await this.endRun(run!, b.actor, b.key));
    }
    if (b.op === 'invite') {
      const a = admissionFor('invite', { run, actor: b.actor, standing: b.standing, now });
      if (!a.ok) return json({ ok: false, error: a.reason }, 403);
      const outsider = b.inviteeStanding === 'none';
      const inv = applyHuddleEvent(run, { type: 'invited', invitation: { invitee: b.invitee, by: b.actor, at: now, expiresAt: now + Number(this.env.HUDDLE_INVITE_TTL_MS ?? 3600_000), outsider }, key: b.key });
      if (!inv.ok) return json({ ok: false, error: inv.reason }, 409);
      await this.save(inv.run);
      // An outsider's invitation waits on a steward (spec 378 §2): said, so the surface can park it.
      return json({ ok: true, run: this.view(inv.run), outsider, ...(outsider ? { parks: 'a steward of this scope must approve an outsider before they can join' } : {}) });
    }
    if (b.op === 'removeParticipant') {
      const a = admissionFor('removeParticipant', { run, actor: b.actor, standing: b.standing, now });
      if (!a.ok) return json({ ok: false, error: a.reason }, 403);
      const target = run!.participants.find((p) => lc(p.actor) === lc(b.target) && !p.removedAt);
      if (!target) return json({ ok: false, error: 'nobody by that address is in this huddle' }, 404);
      // Live media first, then the provider participant (no fresh token), then the record (spec 378 §4).
      if (target.providerParticipantId && run!.provider) {
        await this.media().removeParticipant({ meetingId: run!.provider.meetingId, participantId: target.providerParticipantId }).catch((e: unknown) => console.warn('[huddle] removeParticipant at provider failed:', e instanceof Error ? e.message : String(e)));
      }
      const rem = applyHuddleEvent(run, { type: 'removed', actor: b.target, by: b.actor, at: now, key: b.key });
      if (!rem.ok) return json({ ok: false, error: rem.reason }, 409);
      await this.save(rem.run);
      return json({ ok: true, run: this.view(rem.run) });
    }
    return json({ ok: false, error: 'unknown op' }, 400);
  }

  private async join(b: Extract<Op, { op: 'join' }> | (Extract<Op, { op: 'start' }> & { op: 'join' }), run: HuddleRunV1 | null, now: number, ground?: 'starter'): Promise<Response> {
    const a = ground ? { ok: true as const, ground } : admissionFor('join', { run, actor: b.actor, standing: b.standing, now });
    if (!a.ok) return json({ ok: false, error: a.reason, ...(a.parks ? { parks: true } : {}) }, a.parks ? 202 : 403);
    if (!run?.provider) return json({ ok: false, error: 'there is no active huddle here' }, 404);
    const role = a.ground === 'starter' || a.ground === 'steward' ? 'host' : 'participant';
    const admitted = applyHuddleEvent(run, { type: 'admitted', participant: { actor: b.actor, ...(b.represented ? { represented: b.represented } : {}), role, admission: { ground: a.ground, ...('ref' in a && a.ref ? { ref: a.ref } : {}), at: now } }, at: now, key: `${b.key}:admit` });
    if (!admitted.ok) return json({ ok: false, error: admitted.reason }, 409);
    await this.save(admitted.run);
    // The correlation id is opaque and per join — never an address, never personal (Cloudflare's own rule).
    const correlationId = `${run.runId}:${crypto.randomUUID()}`;
    const p = await this.media().addParticipant({ meetingId: run.provider.meetingId, displayName: b.displayName || 'Participant', role, correlationId });
    // Its own key: a start's join rides the start's operation key, and one key applies once.
    const joined = applyHuddleEvent(admitted.run, { type: 'joined', actor: b.actor, providerParticipantId: p.participantId, at: Date.now(), key: `${b.key}:joined` });
    if (!joined.ok) return json({ ok: false, error: joined.reason }, 409);
    await this.save(joined.run);
    // THE TOKEN GOES OUT ONCE, to the route, to the browser. It is not in the run, not in a log.
    return json({ ok: true, run: this.view(joined.run), participant: { role, correlationId }, authToken: p.authToken });
  }

  private async endRun(run: HuddleRunV1, by: Address, key: string): Promise<Record<string, unknown>> {
    if (run.state === 'ended') return { ok: true, run: this.view(run), already: true };
    const ending = applyHuddleEvent(run, { type: 'ending', by, at: Date.now(), key });
    if (!ending.ok) return { ok: false, error: ending.reason };
    let cur = ending.run;
    await this.save(cur);
    const notes: string[] = [];
    const meetingId = cur.provider?.meetingId;
    if (meetingId) {
      // Spec 378 §4, in order: no future joins, then drop live media. Each failure is said, and the run
      // stays `ending` for the alarm to reconcile rather than being reported done.
      try { await this.media().deactivateMeeting({ meetingId }); const d = applyHuddleEvent(cur, { type: 'provider-deactivated', at: Date.now(), key: `${key}:deactivate` }); if (d.ok) cur = d.run; } catch (e) { notes.push(`deactivate: ${e instanceof Error ? e.message : String(e)}`); }
      try { await this.media().endSession({ meetingId }); const k = applyHuddleEvent(cur, { type: 'provider-kicked', at: Date.now(), key: `${key}:kick` }); if (k.ok) cur = k.run; } catch (e) { notes.push(`kick-all: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (notes.length) { await this.save(cur); return { ok: false, error: `the huddle is ending but the provider did not confirm: ${notes.join('; ')}`, run: this.view(cur), ending: true }; }
    const ended = applyHuddleEvent(cur, { type: 'ended', at: Date.now(), key: `${key}:ended` });
    if (!ended.ok) return { ok: false, error: ended.reason };
    await this.save(ended.run);
    return { ok: true, run: this.view(ended.run) };
  }

  private async onWebhook(run: HuddleRunV1 | null, ev: ProviderWebhookEvent): Promise<Response> {
    if (!run?.provider || run.provider.meetingId !== ev.meetingId) return json({ ok: true, ignored: 'no run for that meeting' });
    // Duplicated, delayed or out-of-order: every event is keyed and the reducer refuses what no longer applies.
    const key = `wh:${ev.event}:${ev.participantId ?? ''}:${ev.at}`;
    if (ev.event === 'meeting.participantLeft' && ev.participantId) {
      const p = run.participants.find((x) => x.providerParticipantId === ev.participantId);
      if (p) { const left = applyHuddleEvent(run, { type: 'left', actor: p.actor, at: ev.at, key }); if (left.ok) await this.save(left.run); }
    } else if (ev.event === 'meeting.ended') {
      if (run.state !== 'ended') { const ended = applyHuddleEvent(run.state === 'ending' ? run : (applyHuddleEvent(run, { type: 'ending', by: run.startedBy, at: ev.at, key: `${key}:ending` }) as { ok: true; run: HuddleRunV1 }).run, { type: 'ended', at: ev.at, key }); if (ended.ok) await this.save(ended.run); }
    }
    return json({ ok: true });
  }

  /** Deadlines: the max duration, and the empty-room grace — the run ends the way `end` ends it. */
  async alarm(): Promise<void> {
    const run = await this.load();
    if (!run || run.state === 'ended') return;
    const now = Date.now();
    const empty = run.emptySince !== undefined && now >= run.emptySince + Number(this.env.HUDDLE_EMPTY_GRACE_MS ?? 120_000);
    const overtime = now >= run.startedAt + run.maxDurationMs;
    const stuck = run.state === 'creating' && now >= run.startedAt + 60_000;
    if (run.state === 'ending' || empty || overtime || stuck) {
      try { await this.endRun(run, run.startedBy, `alarm:${now}`); } catch (e) { console.warn('[huddle] alarm end failed:', e instanceof Error ? e.message : String(e)); await this.state.storage.setAlarm(now + 60_000); }
      return;
    }
    const due = nextDeadline(run, Number(this.env.HUDDLE_EMPTY_GRACE_MS ?? 120_000));
    if (due !== null) await this.state.storage.setAlarm(Math.max(due, now + 1000));
  }
}
