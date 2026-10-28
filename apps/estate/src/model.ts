// What the estate's page says, as data. The heartbeat is the estate's own counts over its last 24 hours (the shape
// `@agenticprimitives/harness/heartbeat` publishes); this turns it into the tiles a steward reads. Two rules:
// ABSENT IS NOT ZERO (an estate that is not a gateway client has no spend, and says so), and A RUN THAT STOPPED
// EARLY IS NOT A GAP (a denial or a park is the authority plane working — spec 438 §4).

export interface Quantiles { p50: number | null; p95: number | null; count: number }
export interface Heartbeat {
  estate: string; at: string; window: '24h'; generation: string; versions: Record<string, string>;
  agents: { person: number; org: number; service: number };
  homesActive24h: number;
  runs: { started: number; completed: number; parked: number; failed: number; canceled: number };
  parkedForSignature: number; modelCalls: number; tokensIn: number; tokensOut: number;
  inferenceMicroUsd: number | null; vaultCalls: number; doRequests: number; askLatencyP95Ms: number | null;
  performance?: { runDurationMs: Quantiles };
  evidenceCoverage?: { runs: number; complete: number; incomplete: number; unknown: number };
}

export type Tone = 'ok' | 'warn' | 'bad' | 'quiet';
export interface Tile { label: string; value: string; sub?: string; tone?: Tone }

export const fmtInt = (n: number): string => n.toLocaleString('en-US');
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
export const fmtUsd = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;
export function fmtAgo(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

/** Older than two sampling intervals (the town samples every five minutes) reads stale, never current. */
export const isStale = (h: Heartbeat, now: number, intervalMs = 300_000): boolean => now - Date.parse(h.at) > 2 * intervalMs;

export function tilesOf(h: Heartbeat): Tile[] {
  const c = h.evidenceCoverage;
  const completed = h.runs.completed;
  const cost = h.inferenceMicroUsd;
  return [
    { label: 'People', value: fmtInt(h.agents.person) },
    { label: 'Organizations', value: fmtInt(h.agents.org) },
    { label: 'Services', value: fmtInt(h.agents.service) },
    { label: 'Homes active 24h', value: fmtInt(h.homesActive24h) },
    { label: 'Runs 24h', value: fmtInt(h.runs.started), sub: `${fmtInt(completed)} completed · ${fmtInt(h.runs.failed)} failed`, ...(h.runs.failed > 0 ? { tone: 'warn' as const } : {}) },
    { label: 'Waiting for a signature', value: fmtInt(h.parkedForSignature), ...(h.parkedForSignature > 0 ? { tone: 'warn' as const } : {}) },
    { label: 'Ask p95', value: fmtMs(h.askLatencyP95Ms) },
    c
      ? { label: 'Records complete', value: `${fmtInt(c.complete)} / ${fmtInt(c.runs)}`, sub: `${fmtInt(c.incomplete)} incomplete · ${fmtInt(c.unknown)} stopped early (not a gap)`, ...(c.incomplete > 0 ? { tone: 'warn' as const } : {}) }
      : { label: 'Records complete', value: '—', sub: 'not computed by this estate', tone: 'quiet' },
    { label: 'Model calls', value: fmtInt(h.modelCalls), ...(cost === null ? { sub: 'spend: not a gateway client yet' } : {}) },
    cost === null
      ? { label: 'Cost over the window', value: '—', sub: 'not a gateway client yet', tone: 'quiet' }
      : { label: 'Cost over the window', value: fmtUsd(cost), sub: completed > 0 ? `${fmtUsd(cost / completed).replace(/0+$/, '')} per completed run` : 'no completed runs' },
    h.performance
      ? { label: 'Run p95', value: fmtMs(h.performance.runDurationMs.p95), sub: `${fmtInt(h.performance.runDurationMs.count)} runs in the block` }
      : { label: 'Run p95', value: '—', sub: 'not recorded', tone: 'quiet' },
  ];
}

/** A heartbeat that fails this is dropped and the estate shown as unreadable — never as zeros. */
export function parseHeartbeat(x: unknown): Heartbeat | null {
  const h = x as Partial<Heartbeat> | null;
  if (!h || typeof h !== 'object') return null;
  if (typeof h.estate !== 'string' || typeof h.at !== 'string' || Number.isNaN(Date.parse(h.at))) return null;
  if (!h.agents || !h.runs || typeof h.runs.started !== 'number' || typeof h.parkedForSignature !== 'number') return null;
  return h as Heartbeat;
}
