// THE ESTATE'S HEARTBEAT — spec 434 §10.2 / spec 436 §5.3 (C10: aggregate, pulled, historical). What this estate
// reports to its town: COUNTS over the last 24 hours, from the operator index this runtime already keeps (spec 406's
// `ops-index.ts`) and the town registry's public facets for who lives here. Never a name, never a person's run — the
// per-agent truth stays at the Home. Served at `GET /ops/heartbeat` under the one token the town holds
// (`TOWN_HEARTBEAT_TOKEN`); the town samples it every five minutes and draws trends.
import type { EstateHeartbeatV1 } from '@agenticprimitives/harness/heartbeat';
import { rollupMetrics, type EstatePerformanceV1 } from '@agenticprimitives/orchestration';
import { ensureOps, type OpsEnv, type OpsRowV1, type PerfColumnV1 } from './ops-index.js';

export interface HeartbeatEnv extends OpsEnv {
  ESTATE_ID?: string;
  TOWN_HEARTBEAT_TOKEN?: string;
  ARD_REGISTRY_ORIGIN?: string;
  /**
   * The registry whose agent census IS this estate's census — set only where that is true.
   *
   * `ARD_REGISTRY_ORIGIN` is the registry this deployment DISCOVERS other agents in, and on a chain with
   * more than one estate it is shared: every estate on faithchain reads the same public KB (ADR-0040), so
   * counting its agents as the estate's own makes each estate claim every other estate's people. imbnet's
   * first heartbeat reported 74 persons and 82 organizations on an estate that had none, which is the
   * knowledge plane telling a plausible falsehood (spec 358) — the authority plane was never involved.
   *
   * Unset ⇒ the heartbeat reports `agents: null`, which the Pulse renders as absent rather than as zero.
   */
  ESTATE_CENSUS_REGISTRY_ORIGIN?: string;
  CONTRACTS_GENERATION?: string;
  WORKERS_CI_COMMIT_SHA?: string;
}

const pct = (xs: number[], p: number): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!; };

/** Agents by type from the registry's public facets (`/facets`): the derived types fold DOWN to the three roots (ADR-0046). */
export async function agentsByType(registryOrigin: string | undefined, fetchImpl: typeof fetch = fetch): Promise<EstateHeartbeatV1['agents'] | null> {
  if (!registryOrigin) return null;
  try {
    const r = await fetchImpl(`${registryOrigin.replace(/\/$/, '')}/facets`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { kinds?: Array<{ value: string; count: number }> };
    const n = (k: string) => j.kinds?.find((x) => x.value === k)?.count ?? 0;
    return { person: n('person'), org: n('org'), service: n('service') };
  } catch { return null; }
}

/** Spec 437 I5 — the performance block from the rows that carry a `perf` column (rows indexed before the column read as "not
 *  recorded" and are left out — the block says how many runs it covers). Absent when no row has one: the town shows no
 *  block, never zeros. Parked wait and first token are not on the index yet: their quantiles have `count: 0`. */
export function performanceOfRows(rows: readonly OpsRowV1[]): EstatePerformanceV1 | undefined {
  const perf = rows.map((r) => { if (!r.perf) return null; try { return { row: r, p: JSON.parse(r.perf) as PerfColumnV1 }; } catch { return null; } }).filter((x): x is { row: OpsRowV1; p: PerfColumnV1 } => !!x && !!x.p?.m);
  if (!perf.length) return undefined;
  return rollupMetrics(perf.map((x) => x.p.m), {
    modelCalls: perf.flatMap((x) => x.p.c ?? []),
    doRequestsPerRun: perf.map((x) => x.row.do_requests),
    failureClasses: perf.map((x) => x.row.failure_class).filter((f): f is string => !!f),
  }, { window: '24h' });
}

/** The heartbeat from the index's last 24 hours of rows over EVERY agent of the estate (the index is estate-wide). */
export function heartbeatOfRows(rows: readonly OpsRowV1[], input: { estate: string; now: number; agents: EstateHeartbeatV1['agents'] | null; generation: string; versions: Record<string, string> }): EstateHeartbeatV1 {
  const kind = (k: string) => rows.filter((r) => r.kind === k).length;
  const answered = rows.filter((r) => r.kind === 'answer' && typeof r.duration_ms === 'number').map((r) => r.duration_ms as number);
  const performance = performanceOfRows(rows);
  return {
    type: 'ap.estate-heartbeat.v1',
    estate: input.estate,
    at: new Date(input.now).toISOString(),
    window: '24h',
    generation: input.generation,
    versions: input.versions,
    agents: input.agents ?? { person: 0, org: 0, service: 0 },
    homesActive24h: new Set(rows.map((r) => r.asker).filter((a): a is string => !!a)).size,
    runs: { started: rows.length, completed: kind('answer') + kind('done'), parked: kind('authority_required'), failed: kind('error'), canceled: rows.filter((r) => r.canceled).length },
    parkedForSignature: kind('authority_required'),
    modelCalls: rows.reduce((n, r) => n + (r.model_calls ?? 0), 0),
    tokensIn: rows.reduce((n, r) => n + (r.tokens_in ?? 0), 0),
    tokensOut: rows.reduce((n, r) => n + (r.tokens_out ?? 0), 0),
    inferenceMicroUsd: null,
    vaultCalls: rows.reduce((n, r) => n + r.vault_calls, 0),
    doRequests: rows.reduce((n, r) => n + r.do_requests, 0),
    askLatencyP95Ms: pct(answered, 0.95),
    ...(performance ? { performance } : {}),
  };
}

export async function estateHeartbeat(env: HeartbeatEnv, fetchImpl: typeof fetch = fetch): Promise<EstateHeartbeatV1 | { error: string }> {
  if (!env.OPS) return { error: 'this deployment keeps no operator index (OPS)' };
  await ensureOps(env.OPS);
  const now = Date.now();
  const res = await env.OPS.prepare('SELECT * FROM runs WHERE at >= ? AND at <= ? ORDER BY at DESC LIMIT 20000').bind(now - 86_400_000, now).all<OpsRowV1>();
  const agents = await agentsByType(env.ESTATE_CENSUS_REGISTRY_ORIGIN, fetchImpl);
  if (!env.ESTATE_ID) return { error: 'this deployment does not say which estate it is (ESTATE_ID unset)' };
  return heartbeatOfRows(res.results ?? [], { estate: env.ESTATE_ID, now, agents, generation: env.CONTRACTS_GENERATION ?? '1', versions: { ...(env.WORKERS_CI_COMMIT_SHA ? { runtime: env.WORKERS_CI_COMMIT_SHA.slice(0, 9) } : {}) } });
}

/** The token check: the one the town holds, compared in constant time; absent on the deployment ⇒ the door is closed, said. */
export function heartbeatAuthorized(env: HeartbeatEnv, authorization: string | null): { ok: true } | { ok: false; status: 401 | 503; error: string } {
  if (!env.TOWN_HEARTBEAT_TOKEN) return { ok: false, status: 503, error: 'this estate publishes no heartbeat (TOWN_HEARTBEAT_TOKEN unset)' };
  const given = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (given.length !== env.TOWN_HEARTBEAT_TOKEN.length) return { ok: false, status: 401, error: 'the heartbeat is read with the town\'s token' };
  let diff = 0; for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ env.TOWN_HEARTBEAT_TOKEN.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, status: 401, error: 'the heartbeat is read with the town\'s token' };
}
