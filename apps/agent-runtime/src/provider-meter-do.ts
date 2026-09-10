// THE PROVIDER METER — spec 388 W3. One Durable Object per deployment holding the rolling per-minute
// token window that spec 388's route reads before it picks a provider.
//
// WHY IT EXISTS. W1's window lived in a module-level map, so it was per Worker ISOLATE: the planner and
// the composer of one turn saw each other's spend, and two concurrent asks did not. On a metered free
// plan that is the case that costs — both isolates read 0, both send, the second waits out a 429's
// 30-60 s retry-after. This object is the one place the minute is counted, so concurrent asks route
// apart instead of colliding.
//
// SERVING PLANE, NOT RECORD (ADR-0055). Everything here is a 60-second counter of ESTIMATES. If this
// object were wiped the loss is a rebuild — the next minute counts itself again — never a bereavement.
// That is also why it keeps no `state.storage`: eviction resets the window, which is the same shape as
// the minute rolling over. The record of which provider carried a call is the flow trace, not this.
//
// ATOMICITY IS THE POINT. `admit` does the whole decision for the METERED candidates inside the object:
// it walks them in the route's order, takes the first whose window carries the estimate, and charges it
// in the same turn of the event loop. A read-then-charge pair across two calls would let two concurrent
// asks both read 0 — the exact race this exists to close.
import { isInternalCall, type InternalMarkerEnv } from './internal-marker.js';
import { SpendWindow, type MeteredCandidate, type SpendReport } from './spend-window.js';

export type ProviderMeterEnv = InternalMarkerEnv;

type Op =
  | { op: 'admit'; candidates: MeteredCandidate[] }
  | { op: 'charge'; provider: string; tokens: number };

export class ProviderMeterDO {
  private window = new SpendWindow();
  constructor(private state: DurableObjectState, private env: ProviderMeterEnv) {}

  async fetch(request: Request): Promise<Response> {
    if (!isInternalCall(request, this.env)) return Response.json({ ok: false, error: 'internal only' }, { status: 403 });
    const body = (await request.json().catch(() => null)) as Op | null;
    if (!body?.op) return Response.json({ ok: false, error: 'op required' }, { status: 400 });
    const now = Date.now();
    if (body.op === 'admit') {
      if (!Array.isArray(body.candidates)) return Response.json({ ok: false, error: 'candidates required' }, { status: 400 });
      const result: SpendReport = this.window.admit(body.candidates, now);
      return Response.json({ ok: true, ...result });
    }
    if (body.op === 'charge') {
      if (typeof body.provider !== 'string' || !Number.isFinite(body.tokens)) return Response.json({ ok: false, error: 'provider + tokens required' }, { status: 400 });
      this.window.charge(body.provider, body.tokens, now);
      return Response.json({ ok: true, picked: null, spent: { [body.provider]: this.window.spent(body.provider, now) } });
    }
    return Response.json({ ok: false, error: `unknown op ${String((body as { op: string }).op)}` }, { status: 400 });
  }
}
