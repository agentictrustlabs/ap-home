// TELL THE SITE HOW THE BUILD IS GOING — one signed POST per step change.
//
//   POST <site>/api/estates/<id>/progress
//   x-build-timestamp: <unix ms>
//   x-build-signature: sha256=<hex HMAC-SHA256(BUILD_CALLBACK_SECRET, "<timestamp>.POST <path>.<body>")>
//
// The path names the estate, so a captured report cannot be replayed against a different one; the site also refuses a
// report older than the last it accepted for the estate.
//
// The site refuses an unsigned report, a report older than five minutes, and one for an estate that is not
// building. The secret is shared by exactly two things: this workflow and the site.
//
// A report that cannot be delivered is LOGGED and the build carries on: the build is the source of truth and the
// page catches up on the next report. The final report is retried, because it carries the sealed custody file.

import { createHmac } from 'node:crypto';
import { hmacSigner, type Signer } from './signer.mts';

export type StepState = 'running' | 'done' | 'skipped' | 'waiting' | 'failed';

export interface Report {
  step: string;
  state: StepState;
  detail?: string;
  /** The custody file sealed with the BUILD's key (checkpoint.mts), so a resumed build gets the same keys back. */
  checkpoint?: string;
  /** The town's own parts (no handover): notes for the town's operators, replacing the last set it sent. */
  operatorNotes?: string[];
  /** Only on the final report. `operatorNotes` is shown to town operators alone (it may carry a heartbeat token). */
  result?: { homeOrigin: string; hosts: Record<string, string>; agents?: Record<string, string>; custody?: unknown; notes?: string[]; operatorNotes?: string[] };
}

export function sign(secret: string, timestamp: string, message: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${message}`).digest('hex')}`;
}

export function reporter(opts: { site?: string; id: string; secret?: string; signer?: Signer; fetchImpl?: typeof fetch; log?: (s: string) => void }) {
  const signer = opts.signer ?? (opts.secret ? hmacSigner(opts.secret) : undefined);
  const log = opts.log ?? ((s: string) => console.log(s));
  const f = opts.fetchImpl ?? fetch;
  // Strictly increasing: the site refuses a report that is not newer than the last one it accepted for the estate.
  let lastTs = 0;
  return async function report(r: Report, { retries = 0 } = {}): Promise<boolean> {
    log(`[${r.state}] ${r.step}${r.detail ? ` — ${r.detail}` : ''}`);
    if (!opts.site || !signer) return false;
    const body = JSON.stringify(r);
    for (let attempt = 0; attempt <= retries; attempt++) {
      lastTs = Math.max(Date.now(), lastTs + 1);
      const ts = String(lastTs);
      const path = `/api/estates/${encodeURIComponent(opts.id)}/progress`;
      try {
        const res = await f(`${opts.site.replace(/\/$/, '')}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-build-timestamp': ts, 'x-build-signature': await signer.header(ts, `POST ${path}.${body}`) },
          body,
        });
        if (res.ok) return true;
        log(`  (the site answered ${res.status} to that report)`);
      } catch (e) {
        log(`  (the site could not be reached: ${(e as Error).message})`);
      }
      if (attempt < retries) await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
    }
    return false;
  };
}
