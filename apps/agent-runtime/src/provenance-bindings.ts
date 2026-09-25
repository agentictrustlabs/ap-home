// THIS DEPLOYMENT'S BINDINGS OF THE PROVENANCE PORTS (spec 414 §5, A0).
//
// The ports are the packages' (`@agenticprimitives/provenance` ProvenanceStorePort, `@agenticprimitives/orchestration`
// TraceExporterPort); what fills them here is deployment: the acting agent's vault through its own effect-write and
// read doors (ADR-0055 — the vault is the record), and an OTLP/HTTP collector when this deployment names one. Another
// deployment binds a Solid pod, a Graph Store or a directory of files to the same ports and passes the same
// conformance suite (`ap conform provenance`, 414 §6); nothing above this file changes.
import type { ProvenanceStorePort } from '@agenticprimitives/provenance';
import { otlpMetricsOf, otlpTracesOf, type TraceExporterPort } from '@agenticprimitives/orchestration';

/** The two vault doors a harness deployment already has (`harnessDeps`). */
export interface VaultDoors {
  writeSubjectRecord?: (subject: string, recordType: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
}

/** The acting agent's vault as a `ProvenanceStorePort`. Absent doors ⇒ no store (the caller says so on its report). */
export function vaultProvenanceStore(doors: VaultDoors): ProvenanceStorePort | undefined {
  const { writeSubjectRecord, readSubjectRecord } = doors;
  if (!writeSubjectRecord && !readSubjectRecord) return undefined;
  return {
    binding: 'mcp-vault',
    async put(ref, document) {
      if (!writeSubjectRecord) return { ok: false, error: 'no vault write door' };
      const out = await writeSubjectRecord(ref.agent.toLowerCase(), ref.key, document);
      return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'vault write refused' };
    },
    async get(ref) {
      if (!readSubjectRecord) return { status: 'refused', reason: 'no vault read door' };
      try {
        const v = await readSubjectRecord(ref.agent.toLowerCase(), ref.key);
        return v && typeof v === 'object' ? { status: 'found', document: v as Record<string, unknown> } : { status: 'absent' };
      } catch (e) {
        // A read that failed is not a read that found nothing (ADR-0013).
        return { status: 'refused', reason: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

export interface OtlpEnv {
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
}

/** OTLP/HTTP JSON to the collector this deployment names — nowhere when it names none. */
export function otlpHttpExporter(env: OtlpEnv, fetchImpl: typeof fetch = fetch, serviceName = 'demo-a2a'): TraceExporterPort {
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    for (const kv of (env.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',')) { const i = kv.indexOf('='); if (i > 0) h[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
    return h;
  };
  const send = async (endpoint: string | undefined, body: unknown) => {
    const url = (endpoint ?? '').trim();
    if (!url) return { sent: false };
    const res = await fetchImpl(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    return res.ok ? { sent: true } : { sent: false, error: `collector answered ${res.status}` };
  };
  return {
    binding: 'otlp-http',
    exportTraces: (spans) => send(env.OTEL_EXPORTER_OTLP_ENDPOINT, otlpTracesOf(spans, { serviceName })),
    exportMetrics: (m) => send(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, otlpMetricsOf(m, { serviceName })),
  };
}

/** Spec 406 W3's CARRIED record, read under the same claim the run-record path admits. A record carried into this
 *  Home is its owner's own record (`/harness/records/import` writes only into the caller's own vault), so the reader
 *  must be the agent itself or its steward — the check runs BEFORE the read, so a refused caller cannot even learn
 *  whether a record exists. Before this, any valid Home session could read any agent's carried bundle by runRef. */
export async function readCarriedProvenance(
  store: ProvenanceStorePort | undefined,
  caller: string,
  agent: string,
  key: string,
  mayOversee: (caller: string, agent: string) => Promise<boolean>,
): Promise<{ status: 'found'; document: Record<string, unknown> } | { status: 'absent' } | { status: 'forbidden' } | { status: 'refused'; reason: string }> {
  if (!(await mayOversee(caller, agent).catch(() => false))) return { status: 'forbidden' };
  if (!store) return { status: 'refused', reason: 'no vault read door' };
  return store.get({ agent, key });
}
