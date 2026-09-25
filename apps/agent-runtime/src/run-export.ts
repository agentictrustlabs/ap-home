// THE RUN, EXPORTED — the app's half of spec 381 (appendix N3).
//
// The projections are the package's (`@agenticprimitives/orchestration` spans.ts, pure and firewalled). This
// file is where they LAND, which is deployment: the provenance record into the acting agent's vault through
// its own effect-write door, and the spans to an OTLP/HTTP collector when this deployment names one.
// Neither is on the run's path — a record that failed to export costs an export, never the run.
import { bundleDigest, ZERO32 } from './receipt-anchor.js';
import { intentDigest } from '@agenticprimitives/delegation';
import type { Hex, Address } from 'viem';
import { estateIdOf } from '@agenticprimitives/estate-projection';
import { assertFirewalled, assertMetricsFirewalled, metricsOf, provenanceOf, runProvenanceRecordKey, spansOf, type RunRecordV1, type RunExportReportV1, type RunMetricsV1, type SpanV1 } from '@agenticprimitives/orchestration';
import { projectHarnessRunProvenance, toJsonLd, toProvN, type ProvenanceRecordV1, projectPublicProvenance, type PublicProvenanceProjection } from '@agenticprimitives/provenance';
import { RUN_PROVENANCE_CONTEXT } from '@agenticprimitives/ontology';
import type { ProvenanceStorePort } from '@agenticprimitives/provenance';
import type { TraceExporterPort } from '@agenticprimitives/orchestration';
import { otlpHttpExporter } from './provenance-bindings.js';

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
  /** Spec 410 §4.4 — this estate's `AgenticGovernance` on `CHAIN_ID`; with it every bundle carries `apexec:estate`
   *  (the estate id), so a record carried into a vault held in another estate still says where the act happened.
   *  Absent ⇒ not stamped, and the report's anchor citation names no estate. */
  AGENTIC_GOVERNANCE?: string;
}

/** Spec 410 §4.4 — the estate this runtime belongs to, as its id; null when the deployment has not declared it. */
export function estateOf(env: Pick<RunExportEnv, 'CHAIN_ID' | 'AGENTIC_GOVERNANCE'>): Hex | null {
  const chainId = Number(env.CHAIN_ID);
  const gov = (env.AGENTIC_GOVERNANCE ?? '').trim();
  if (!Number.isFinite(chainId) || chainId <= 0 || !/^0x[0-9a-fA-F]{40}$/.test(gov)) return null;
  return estateIdOf(chainId, gov.toLowerCase() as Address);
}
/** Spec 410 §4.4 — the vault record that cites where a run's bundle is anchored, beside the bundle. */
export const runAnchorRecordKey = (runRef: string): string => `run.anchor:${runRef}`;

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
export async function provenanceRecordOf(env: Pick<RunExportEnv, 'CHAIN_ID' | 'AGENTIC_GOVERNANCE'>, agent: string, record: RunRecordV1): Promise<{ graph: ProvenanceRecordV1; chainId?: number }> {
  const view = await provenanceOf(record, agent);
  const chainId = Number(env.CHAIN_ID);
  const known = Number.isFinite(chainId) && chainId > 0 ? { chainId } : {};
  // Spec 410 §4.4 — the estate the run was performed in, from THIS deployment: the record may be carried elsewhere.
  const estate = estateOf(env);
  return { graph: projectHarnessRunProvenance({ ...view, ...known, ...(estate ? { estate } : {}) }), ...known };
}
/** Spec 398 §5.2 — THE INSPECTOR'S VIEW: the same structural record (`RunProvenanceV1`), as records rather than as a
 *  graph — outcome, artifacts, decisions, per-step authority, effects, bill — for a surface that orders it
 *  artifact-first. Never the arguments, results or words: the firewall is the same one the graph passes. */
export async function provenanceViewOf(env: Pick<RunExportEnv, 'CHAIN_ID'>, agent: string, record: RunRecordV1): Promise<Awaited<ReturnType<typeof provenanceOf>> & { chainId?: number; bill?: RunRecordV1['bill']; canceled?: RunRecordV1['canceled']; plannedSteps?: number }> {
  const view = await provenanceOf(record, agent);
  const chainId = Number(env.CHAIN_ID);
  return { ...view, ...(Number.isFinite(chainId) && chainId > 0 ? { chainId } : {}), ...(record.bill ? { bill: record.bill } : {}), ...(record.canceled ? { canceled: record.canceled } : {}), plannedSteps: record.plan.steps.length };
}
export async function provenanceGraphOf(env: Pick<RunExportEnv, 'CHAIN_ID' | 'AGENTIC_GOVERNANCE'>, agent: string, record: RunRecordV1): Promise<Record<string, unknown>> {
  const { graph, chainId } = await provenanceRecordOf(env, agent, record);
  return toJsonLd(graph, { context: RUN_PROVENANCE_CONTEXT['@context'] as unknown as Record<string, unknown>, ...(chainId ? { chainId } : {}) });
}
/** Spec 389 W3 — the same record in PROV-N, for a reader or a tool that wants provenance and not JSON. */
export async function provenanceProvNOf(env: Pick<RunExportEnv, 'CHAIN_ID' | 'AGENTIC_GOVERNANCE'>, agent: string, record: RunRecordV1): Promise<string> {
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
  assertMetricsFirewalled([...m.runs, ...m.verdicts, ...m.stepDuration, ...m.modelCalls, ...m.vaultCalls], record);
  return m;
}

/** The firewalled spans of a record — what `/harness/spans` serves and the collector receives. */
export async function firewalledSpans(record: RunRecordV1): Promise<SpanV1[]> {
  const spans = await spansOf(record);
  assertFirewalled(spans, record);
  return spans;
}

export interface RunExportDeps {
  /** Spec 414 §5 — where the record is KEPT: the acting agent's vault in this deployment (`vaultProvenanceStore`,
   *  over its own effect-write door, ADR-0055); any conforming binding elsewhere. Absent ⇒ not kept, said. */
  store?: ProvenanceStorePort;
  /** Spec 414 §5 — where firewalled spans and metrics GO: OTLP/HTTP by default (`otlpHttpExporter`). */
  exporter?: TraceExporterPort;
  /** Spec 406 W2 — anchor the bundle's digest on chain from the runtime's harness agent; absent ⇒ not anchored, said. */
  anchor?: (digest: Hex, intentDigest: Hex, mandateRef: Hex) => Promise<{ txHash: Hex; registry: Address; anchoredBy: Address; chainId?: number }>;
  fetch?: typeof fetch;
}

export type RunExportReport = RunExportReportV1;

/** Export one finished run: provenance to the vault, spans to the collector (when one is named). */
export async function exportRun(env: RunExportEnv, deps: RunExportDeps, agent: string, record: RunRecordV1): Promise<RunExportReport> {
  const recordType = runProvenanceRecordKey(record.runRef);
  const report: RunExportReport = { at: Date.now(), provenance: { written: false, recordType }, spans: { count: 0, sent: false } };
  // The durable half, into the vault of the agent whose authority was spent — through ITS door, under ITS grant.
  let prov: Record<string, unknown> | null = null;
  if (deps.store) {
    try {
      prov = await provenanceGraphOf(env, agent, record);
      const out = await deps.store.put({ agent, key: recordType }, prov);
      report.provenance.written = out.ok;
      if (!out.ok) report.provenance.error = out.error;
    } catch (e) { report.provenance.error = e instanceof Error ? e.message : String(e); }
  } else report.provenance.error = 'no vault write door';
  // Spec 406 W2 — THE ANCHOR: the bundle's digest on chain, bound to the intent and the mandate, from the harness agent.
  // Every finished run, transaction of its own or not. A failure is said on the report; the record stands.
  if (deps.anchor) {
    try {
      const digest = bundleDigest(prov ?? (await provenanceGraphOf(env, agent, record)));
      const mandateRef = (record.presented?.[0]?.ref as Hex | undefined) ?? ZERO32;
      const out = await deps.anchor(digest, intentDigest(record.intent as never) as Hex, /^0x[0-9a-f]{64}$/i.test(mandateRef) ? mandateRef : ZERO32);
      report.anchor = { digest, registry: out.registry, anchoredBy: out.anchoredBy, txHash: out.txHash, ...(out.chainId ? { chainId: out.chainId } : {}) };
      // Spec 410 §4.4 — THE CITATION, beside the bundle: a bundle cannot carry its own digest's anchor, and a Home in
      // another estate needs to know WHICH chain to ask. Chain-qualified registry + the estate; a claim about where
      // to look, verified by recomputing the digest and reading the registry there.
      if (deps.store) {
        const recordType = runAnchorRecordKey(record.runRef);
        const estate = estateOf(env);
        const cite = { runRef: record.runRef, digest, registry: out.chainId ? `eip155:${out.chainId}:${out.registry}` : out.registry, anchoredBy: out.anchoredBy, txHash: out.txHash, ...(estate ? { estate } : {}) };
        try {
          const w = await deps.store.put({ agent, key: recordType }, cite);
          report.anchorRecord = { written: w.ok, recordType, ...(!w.ok ? { error: w.error } : {}) };
        } catch (e) { report.anchorRecord = { written: false, recordType, error: e instanceof Error ? e.message : String(e) }; }
      }
    } catch (e) { report.anchor = { error: e instanceof Error ? e.message : String(e) }; }
  }
  // The spans — firewalled BEFORE the port, carried by whichever binding this deployment names.
  const exporter = deps.exporter ?? otlpHttpExporter(env, deps.fetch ?? fetch);
  try {
    const spans = await firewalledSpans(record);
    report.spans.count = spans.length;
    const out = await exporter.exportTraces(spans);
    report.spans.sent = out.sent;
    if (out.error) report.spans.error = out.error;
  } catch (e) { report.spans.error = e instanceof Error ? e.message : String(e); }
  // Spec 390 W4 — the metrics, the same way: projected and firewalled, sent only where this deployment says.
  try {
    const m = firewalledMetrics(record);
    const points = m.runs.length + m.verdicts.length + m.stepDuration.length + m.modelCalls.length;
    report.metrics = { points, sent: false };
    const out = await exporter.exportMetrics(m);
    report.metrics.sent = out.sent;
    if (out.error) report.metrics.error = out.error;
  } catch (e) { report.metrics = { points: 0, sent: false, error: e instanceof Error ? e.message : String(e) }; }
  return report;
}
