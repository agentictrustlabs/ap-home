# Spec 381 — Run export: firewalled spans, a declared retention, and the run's provenance in the acting agent's vault

**Status:** W1 ✅ shipped + live on faithnet 2026-09-08 (§4); W2 (trace-context over A2A) and W3 (the Home surface) open · **Kind:** Orchestration projections (pure) + one app exporter + one vault record + one declared policy
**Grounds:** [370](370-harness-parity-ledger-and-program.md) P6 (`RunRecordV1` + `replayRun`; "export stays a sibling") · [351](351-agentic-primitives-substrate-program.md) §2.3 / P0.14 (OTEL-compatible semantic events: the vocabulary here, the SDK exporter in Ring 1) · ADR-0055 (the vault is the record; DO-local is a rebuild — *if this DO were wiped, is the loss a rebuild or a bereavement?*) · ADR-0040 (nothing private leaves the estate by a side door) · [356](356-ontology-grounded-vault-questions.md) W1 (a vault record key is bound to a T-box class) · appendix N3 in [`harness-parity-gap-analysis.md`](../docs/architecture/product-comparison/harness-parity-gap-analysis.md)

## 0. The gap

LangSmith keeps every run as a tree you can query; MAF emits GenAI spans to whatever collector you point it at;
Temporal keeps history until you say otherwise. P6 gave this harness the record and the replay, and left three
things open: nothing left the estate for a trace tool to read, the record's life was an unstated week in a
Durable Object, and the durable half of the record — what was DONE, under what authority, leaving what receipt
— lived only in that rebuildable copy. This spec closes all three with one constraint the others do not have:
**a trace leaves the estate and a vault record outlives the run, so neither may carry what the run was
about.**

## 1. The rule, stated once

**An export carries what was done, never what it was about.** Step names, tool ids, capability ids, risk,
the authority decision and the reference it was made against, receipt digests, playbook commitments, timings,
outcomes: yes. The utterance, a step's arguments, a counterparty's address, a result, a name: no — a payee is
a digest away from a receipt, never in a span. The allowlist is the whole of the export surface, and every
value is re-read against the record before anything leaves; a leak is a refusal that names the attribute, not
an export with the leak in it.

## 2. The shape

| Piece | What | Where |
| --- | --- | --- |
| **spans** | `spansOf(record)` → one `invoke_agent` root + one `execute_tool` span per step; attribute names from the OpenTelemetry GenAI semantic conventions where one exists (`gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`) and `ap.*` for what this substrate adds; W3C-sized ids derived from the run and step refs (the same record is the same trace) | `packages/orchestration/src/spans.ts` |
| **the firewall** | `SPAN_ATTRIBUTE_ALLOWLIST` + `assertFirewalled(spans, record)`: unknown attribute ⇒ throw; any value carrying an address, the intent's words or a step argument ⇒ throw naming the span and attribute. A receipt's `inputDigest`/`outputDigest` is only a digest when it looks like one — this estate also records `json:{…}` for replay matching, which is hashed at export | same |
| **OTLP** | `otlpTracesOf(spans, { serviceName })` — the `ExportTraceServiceRequest` JSON body, pure. The app posts it to `OTEL_EXPORTER_OTLP_ENDPOINT` with `OTEL_EXPORTER_OTLP_HEADERS` when set; absent ⇒ nothing is sent and the spans are still served | `apps/demo-a2a/src/run-export.ts` |
| **`POST /harness/spans`** | `{ session, addressee, runRef }` → the firewalled spans, the retention, which exporter is configured; the asker's own runs only (P6's rule) | `apps/demo-a2a/src/index.ts` |
| **provenance** | `provenanceOf(record, agent)` → `RunProvenanceV1`: the run, the agent whose authority was spent, the asker, the intent digest, the playbook commitment, and per step the capability, risk, status, timings, authority (reference + decision), receipt digest, the chain tx a result named, effects and decisions BY NAME, an error's class. Never arguments, results or words | `packages/orchestration/src/spans.ts` |
| **the vault record** | `run.provenance:<runRef>` in the ACTING agent's vault (the addressee: the person for their own run, the organization for a routed one) through its own effect-write door (`internal.coordination.vaultWrite`, ADR-0055) under its own grant (`vault:run.provenance:*`, both scope lists). Bound to `apexec:ServiceExecution` (a `prov:Activity`; `endedAt` → `prov:endedAtTime`) so a vault question can mean it | `ontology/src/vault-records.ts`, `genesis-planes.ts`, Home `delegation.ts`, `interactions-do.ts` |
| **retention** | `HARNESS_RECORD_RETENTION_DAYS` (default 7): the DO copy's life, swept on listing and stated in the listing (`retention: { doDays, vaultRecord }`). The policy is now a sentence a steward can read: *the object keeps a rebuildable copy for N days; the vault keeps the provenance.* | `run-export.ts`, `a2a-task-do.ts` |

**Where the export happens.** Both places a record is kept — the ask route and a routed act's delivery
(374 §4) — export after the record lands, off the run's path (`waitUntil`). A failed export is logged, never a
failed ask.

## 3. Boundaries (the drift to refuse)

- **No attribute outside the allowlist.** "Just this one field" is how a payee ends up in a dashboard.
  Widening the list is a change to this spec and to `assertFirewalled`'s test.
- **No SDK in Ring 0.** The OpenTelemetry SDK (batching, gRPC, propagation) is a sibling's binding
  (351 §2.3). This repo owns the MAPPING — the part that must be right — and one HTTP POST in the app.
- **The vault is the record; the DO is the rebuild.** Provenance is written where the authority was spent,
  under that agent's grant, and nowhere else. The DO's copy may be wiped at N days; the vault's may not be
  written by anyone but the door.
- **Provenance is not evidence for a verifier.** It is what a person or an auditor reads later; no gate
  consults it (spec 354 §1). Recording that a step was allowed grants nothing.
- **A stranger learns nothing from a span.** Ids are derived from refs, agents appear as digests when at
  all, and the asker's session is required to read spans, exactly as for the record.

## 4. Waves + gates

| Wave | Delivers | Gate |
| --- | --- | --- |
| **W1** ✅ 2026-09-08 | spans + firewall + OTLP body (pure); `/harness/spans`; provenance record + ontology binding + scope on both sides + effect-writable; declared retention; export at both record sites | unit `spans.test.ts` (a payment record's spans carry the step names and receipt digests and not the payee, the utterance, an argument or a result; the firewall refuses by name and by value; the OTLP body; provenance carries the tx and no argument). **Live** `scripts/verify-run-export.mts`: alice pays nathan.treasury 1 USDC (the single-mandate path) → `/harness/spans` serves 2+ spans, the payment span carries `ap.receipt.digest` and `ap.authority.decision=allow`, and no span's JSON contains the payee's address, the treasury's name or the utterance; the records listing states the retention; alice's vault holds `run.provenance:<runRef>` (read through her own vault question). **Found on the way:** a receipt's `inputDigest` is `json:{…}` in this estate (the arguments, for replay matching) — it went straight into a span until the firewall test caught it; a non-hash is now hashed at export. A grant's record-scope caveat is fixed at signing, so the new `vault:run.provenance:*` scope reached alice only by re-issuing her interactions grant (`scripts/reissue-interactions-grants.mts alice`) — the first live run reported `record_scope_denied` ON THE RECORD (`export.provenance.error`), which is the point of writing the report back. Live: 2 spans, `ap.authority.decision=allow`, `ap.receipt.digest` present, playbook `skill:archetypes/person-steward`; nothing of the payee, the name or the words; listing states `{ doDays: 7, vaultRecord }`; her vault question answers "1 run provenance record" |
| **W2** | W3C trace-context over A2A (351 P1.4): a routed step's receiver joins the sender's trace; `ap.delegated_to.agent_digest` becomes a link | a routed run is one trace across two agents |
| **W3** | the Home reads a run's provenance from the vault (the "what did my agent do" surface) and offers the spans as a download | screen parity |

## Reference: patterns to port

- OpenTelemetry GenAI semantic conventions (`gen_ai.*`) for the names; MAF's workflow/step span shape for the
  tree. Diverged on: every attribute allowlisted and re-read (they export prompts and completions by
  default; we export neither, ever), and the durable half in a vault the person owns rather than a vendor's
  trace store.
