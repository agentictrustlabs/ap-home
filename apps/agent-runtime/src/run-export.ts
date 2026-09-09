// THE RUN, EXPORTED — the app's half of spec 381 (appendix N3).
//
// The projections are the package's (`@agenticprimitives/orchestration` spans.ts, pure and firewalled). This
// file is where they LAND, which is deployment: the provenance record into the acting agent's vault through
// its own effect-write door, and the spans to an OTLP/HTTP collector when this deployment names one.
// Neither is on the run's path — a record that failed to export costs an export, never the run.
import { assertFirewalled, otlpTracesOf, provenanceOf, runProvenanceRecordKey, spansOf, type RunRecordV1, type RunExportReportV1, type SpanV1 } from '@agenticprimitives/orchestration';

export interface RunExportEnv {
  /** An OTLP/HTTP collector's traces endpoint (`https://…/v1/traces`). Absent ⇒ spans are not sent anywhere. */
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  /** `k=v,k=v` — the collector's headers (an auth token, a dataset). Values are the deployment's secret. */
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  /** Days a run record stays on the agent's task object before the sweep (default 7). The vault copy is the record. */
  HARNESS_RECORD_RETENTION_DAYS?: string;
}

export const DEFAULT_RECORD_RETENTION_DAYS = 7;

/** The declared retention: the DO copy's life, and where the durable half lives. */
export function recordRetention(env: RunExportEnv): { doDays: number; vaultRecord: string } {
  const n = Number(env.HARNESS_RECORD_RETENTION_DAYS);
  return { doDays: Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RECORD_RETENTION_DAYS, vaultRecord: 'run.provenance:<runRef>' };
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
      const prov = await provenanceOf(record, agent);
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
  return report;
}
