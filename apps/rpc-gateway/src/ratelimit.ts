export class RateLimiter {
  constructor(private state: DurableObjectState) {}
  async fetch(req: Request): Promise<Response> {
    const { reads, writes, readRps, writeRps } = await req.json() as { reads: number; writes: number; readRps: number; writeRps: number };
    const now = Date.now();
    const take = async (kind: 'r' | 'w', want: number, rps: number) => {
      if (want <= 0) return { ok: true };
      const cap = rps <= 0 ? 0 : Math.max(rps * 2, 1);
      const s = (await this.state.storage.get<{ tokens: number; ts: number }>(kind)) ?? { tokens: cap, ts: now };
      const refilled = Math.min(cap, s.tokens + ((now - s.ts) / 1000) * rps);
      if (refilled < want) return { ok: false, retryAfter: Math.ceil((want - refilled) / rps) };
      await this.state.storage.put(kind, { tokens: refilled - want, ts: now });
      return { ok: true };
    };
    const r = await take('r', reads, readRps); if (!r.ok) return Response.json(r);
    return Response.json(await take('w', writes, writeRps));
  }
}
