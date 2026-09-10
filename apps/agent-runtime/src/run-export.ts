// THE RUN, EXPORTED — the app's half of spec 381 (appendix N3).
//
// The projections are the package's (`@agenticprimitives/orchestration` spans.ts, pure and firewalled). This
// file is where they LAND, which is deployment: the provenance record into the acting agent's vault through
// its own effect-write door, and the spans to an OTLP/HTTP collector when this deployment names one.
// Neither is on the run's path — a record that failed to export costs an export, never the run.
import { assertFirewalled, assertMetricsFirewalled, otlpTracesOf, otlpMetricsOf, metricsOf, provenanceOf, runProvenanceRecordKey, spansOf, type RunRecordV1, type RunExportReportV1, type RunMetricsV1, type SpanV1 } from '@agenticprimitives/orchestration';
import { projectHarnessRunProvenance, toJsonLd, toProvN, type ProvenanceRecordV1, projectPublicProvenance, type PublicProvenanceProjection } from '@agenticprimitives/provenance';
import { RUN_PROVENANCE_CONTEXT } from '@agenticprimitives/ontology';

export interface RunExportEnv {
  /** An OTLP/HTTP collector's traces endpoint (`https://…/v1/traces`). Absent ⇒ spans are not sent anywhere. */
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  /** `k=v,k=v` — the collector's headers (an auth token, a dataset). Values are the deployment's secret. */
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  /** Spec 390 W4 — the collector's metrics endpoint (`https://…/v1/metrics`). Absent ⇒ metrics are projected and served, not sent. */
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?: string;
  /** Days a run record stays on the agent's task object before the sweep (default 7). The vault copy is the record. */
  HARNESS_RECORD_RETENTION_DAYS?: string;
  /** The chain the agents live on — the provenance graph names them the way the public KB does (spec 389 §2). */
  CHAIN_ID?: string;
}

export const DEFAULT_RECORD_RETENTION_DAYS = 7;

/** The declared retention: the DO copy's life, and where the durable half lives. */
export function recordRetention(env: RunExportEnv): { doDays: number; vaultRecord: string } {
  const n = Number(env.HARNESS_RECORD_RETENTION_DAYS);
  return { doDays: Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RECORD_RETENTION_DAYS, vaultRecord: 'run.provenance:<runRef>' };
}

/** Spec 389 — THE RECORD AS A GRAPH: the structural view `provenanceOf` extracts (digests, verdicts, the chain
 *  by reference — never arguments, results or words), projected by the Ring-0 provenance projector into the
 *  same PROV-O / P-Plan record an Endeavor leaves, serialized as JSON-LD under the published context. What
 *  lands in the vault is a document a stock PROV tool loads unchanged. */
export async function provenanceRecordOf(env: Pick<RunExportEnv, 'CHAIN_ID'>, agent: string, record: RunRecordV1): Promise<{ graph: ProvenanceRecordV1; chainId?: number }> {
  const view = await provenanceOf(record, agent);
  const chainId = Number(env.CHAIN_ID);
  const known = Number.isFinite(chainId) && chainId > 0 ? { chainId } : {};
  return { graph: projectHarnessRunProvenance({ ...view, ...known }), ...known };
}
export async function provenanceGraphOf(env: Pick<RunExportEnv, 'CHAIN_ID'>, agent: string, record: RunRecordV1): Promise<Record<string, unknown>> {
  const { graph, chainId } = await provenanceRecordOf(env, agent, record);
  return toJsonLd(graph, { context: RUN_PROVENANCE_CONTEXT['@context'] as unknown as Record<string, unknown>, ...(chainId ? { chainId } : {}) });
}
/** Spec 389 W3 — the same record in PROV-N, for a reader or a tool that wants provenance and not JSON. */
export async function provenanceProvNOf(env: Pick<RunExportEnv, 'CHAIN_ID'>, agent: string, record: RunRecordV1): Promise<string> {
  const { graph, chainId } = await provenanceRecordOf(env, agent, record);
  return toProvN(graph, chainId ? { chainId } : {});
}
/** Spec 389 W3 — WHERE A RUN'S PROVENANCE IS (PROV-AQ `hasProvenance`): the agent whose vault holds it and the
 *  record key. A reference, never the record: resolving it takes that agent's grant (ADR-0055). */
export function hasProvenanceRef(agent: string, runRef: string): { agent: string; recordType: string; public: { route: string; agent: string; runRef: string } } {
  // Spec 395 — where ANYONE may read the run's ANCHORED OUTCOMES (digests and ids through the S1 firewall): the
  // acting agent's own public route. A holder of a receipt verifies by recomputation; nothing private is served.
  return { agent: agent.toLowerCase(), recordType: runProvenanceRecordKey(runRef), public: { route: '/provenance/public', agent: agent.toLowerCase(), runRef } };
}

/** Spec 395 — the run's anchored outcomes, safe for anyone: one row per step that left a chain transaction, every
 *  row through the S1 firewall; the rest refused by name. Served without a session; the private graph is not. */
export async function publicProvenanceOf(env: Pick<RunExportEnv, 'CHAIN_ID'>, agent: string, record: RunRecordV1): Promise<PublicProvenanceProjection> {
  const { graph } = await provenanceRecordOf(env, agent, record);
  return projectPublicProvenance(graph);
}

/** Spec 390 W4 — the firewalled metrics of a record: four instruments, one delta point each per attribute set. */
export function firewalledMetrics(record: RunRecordV1): RunMetricsV1 {
  const m = metricsOf(record);
  assertMetricsFirewalled([...m.runs, ...m.verdicts, ...m.stepDuration, ...m.modelCalls], record);
  return m;
}

/** The firewalled spans of a record — what `/harness/spans` serves and the collector receives. */
export async function firewalledSpans(record: RunRecordV1): Promise<SpanV1[]> {
  const spans = await spansOf(record);
  assertFirewalled(spans, record);
  return spans;
}

export interface RunExportDeps {
  /** The acting agent's own effect-write door (`internal.coordination.vaultWrite`, ADR-0055). */
  writeSubjectRecord?: (subject: string, recordType: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
  fetch?: typeof fetch;
}

export type RunExportReport = RunExportReportV1;

/** Export one finished run: provenance to the vault, spans to the collector (when one is named). */
export async function exportRun(env: RunExportEnv, deps: RunExportDeps, agent: string, record: RunRecordV1): Promise<RunExportReport> {
  const recordType = runProvenanceRecordKey(record.runRef);
  const report: RunExportReport = { at: Date.now(), provenance: { written: false, recordType }, spans: { count: 0, sent: false } };
  // The durable half, into the vault of the agent whose authority was spent — through ITS door, under ITS grant.
  if (deps.writeSubjectRecord) {
    try {
      const prov = await provenanceGraphOf(env, agent, record);
      const out = await deps.writeSubjectRecord(agent.toLowerCase(), recordType, prov);
      report.provenance.written = out.ok;
      if (!out.ok && out.error) report.provenance.error = out.error;
    } catch (e) { report.provenance.error = e instanceof Error ? e.message : String(e); }
  } else report.provenance.error = 'no vault write door';
  // The spans — firewalled before they leave, sent only where this deployment says.
  try {
    const spans = await firewalledSpans(record);
    report.spans.count = spans.length;
    const endpoint = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim();
    if (endpoint) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      for (const kv of (env.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',')) { const i = kv.indexOf('='); if (i > 0) headers[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
      const res = await (deps.fetch ?? fetch)(endpoint, { method: 'POST', headers, body: JSON.stringify(otlpTracesOf(spans, { serviceName: 'demo-a2a' })) });
      report.spans.sent = res.ok;
      if (!res.ok) report.spans.error = `collector answered ${res.status}`;
    }
  } catch (e) { report.spans.error = e instanceof Error ? e.message : String(e); }
  // Spec 390 W4 — the metrics, the same way: projected and firewalled, sent only where this deployment says.
  try {
    const m = firewalledMetrics(record);
    const points = m.runs.length + m.verdicts.length + m.stepDuration.length + m.modelCalls.length;
    report.metrics = { points, sent: false };
    const endpoint = (env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? '').trim();
    if (endpoint) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      for (const kv of (env.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',')) { const i = kv.indexOf('='); if (i > 0) headers[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
      const res = await (deps.fetch ?? fetch)(endpoint, { method: 'POST', headers, body: JSON.stringify(otlpMetricsOf(m, { serviceName: 'demo-a2a' })) });
      report.metrics.sent = res.ok;
      if (!res.ok) report.metrics.error = `collector answered ${res.status}`;
    }
  } catch (e) { report.metrics = { points: 0, sent: false, error: e instanceof Error ? e.message : String(e) }; }
  return report;
}
