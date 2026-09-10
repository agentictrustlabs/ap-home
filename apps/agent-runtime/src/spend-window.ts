// THE MINUTE, COUNTED — spec 388's rolling per-provider token window, as one pure object.
//
// Two things hold one of these: the Worker isolate (W1's default, honest about seeing only its own
// requests) and the `ProviderMeterDO` (W3's shared meter, one per deployment). Keeping the arithmetic
// here means both count a minute the same way, and the tests exercise it without a Durable Object.
//
// It counts ESTIMATES, not the provider's own accounting: what the route measured before it sent. The
// route decides on estimates, so it charges what it decided on — a window in a different currency from
// the decision would be a third number nobody could check the trace against.

/** One provider the route would consider, with its meter and what this call would cost it. */
export interface MeteredCandidate {
  provider: string;
  /** Tokens per minute this provider's plan allows. */
  tpm: number;
  /** The estimate this call would charge. */
  tokens: number;
  /** May this candidate WIN? A provider whose per-request budget the call already exceeds is still listed —
   *  the trace reports the minute it stood at — but it cannot take the call. */
  eligible: boolean;
}

export interface SpendReport {
  /** The first candidate whose window carried the estimate — already charged. `null` when none did. */
  picked: string | null;
  /** What each candidate's window stood at WHEN THE DECISION WAS MADE (before the charge), so the
   *  trace's numbers and the reason beside them are the same numbers. */
  spent: Record<string, number>;
}

const WINDOW_MS = 60_000;

export class SpendWindow {
  private rows = new Map<string, Array<{ at: number; tokens: number }>>();

  /** What this window has been charged for `provider` in the last 60 s. Prunes as it reads. */
  spent(provider: string, now: number): number {
    const kept = (this.rows.get(provider) ?? []).filter((r) => now - r.at < WINDOW_MS);
    this.rows.set(provider, kept);
    return kept.reduce((n, r) => n + r.tokens, 0);
  }

  charge(provider: string, tokens: number, now: number): void {
    const kept = (this.rows.get(provider) ?? []).filter((r) => now - r.at < WINDOW_MS);
    kept.push({ at: now, tokens });
    this.rows.set(provider, kept);
  }

  /** Walk the candidates IN THE ROUTE'S ORDER, take the first whose window carries its estimate, charge
   *  it. Read and charge happen together so two callers cannot both see an empty minute. */
  admit(candidates: MeteredCandidate[], now: number): SpendReport {
    const spent: Record<string, number> = {};
    let picked: string | null = null;
    for (const c of candidates) {
      const before = this.spent(c.provider, now);
      spent[c.provider] = before;
      if (picked === null && c.eligible && c.tokens + before <= c.tpm) {
        picked = c.provider;
        this.charge(c.provider, c.tokens, now);
      }
    }
    return { picked, spent };
  }

  clear(): void { this.rows.clear(); }
}
