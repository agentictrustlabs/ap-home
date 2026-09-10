# Spec 391 — Context management for long runs: offloaded artifacts, fitted evidence, a checkpoint that stays small

**Status:** W1–W3 ✅ 2026-09-10 (offload + fitted evidence live on faithnet; a re-plan sees shapes; sub-work offloads by the same rule with its facts retained). **The spec is complete.** · **Kind:** Ring-0 projection (`orchestration`) + an app-bound artifact store + one vault record type + PROV entities · **Grounds:** [harness-feature-priorities.md](../docs/architecture/harness-feature-priorities.md) P1 ("the one row unchanged since 09-05"), [spec 370](370-harness-parity-ledger-and-program.md) P1 (the checkpoint carries the admitted plan and the completed steps), [spec 376](376-handoff-as-a-child-delegation.md) (sub-work as a child delegation), [spec 358](358-semantic-context-plane.md) W3 (the composer's claims bounded by its evidence), [spec 389](389-provenance-unification-one-prov-graph.md) (an offloaded artifact is a `prov:Entity` the step generated), ADR-0055 (the vault is the record; DO-local is a rebuild), ADR-0013 (no silent mechanism)

## 0. The gap, measured on this tree

Deep Agents offload large tool results to a filesystem and summarise the conversation; LangGraph trims
messages. This harness had none of that, and the tree shows where a long run's context goes today:

1. **The composer's evidence is cut silently.** `createAnthropicComposer` / the OpenAI-compat composer do
   `stringify(evidence).slice(0, cap)` (24,000 / 12,000 chars). A result past the cap is truncated
   mid-JSON, with no record of what was dropped and no signal to the governor (358 W3) that the model
   saw half a list. This is the exact "plausible falsehood" failure spec 358 names, at the last stage.
2. **Every full result rides in three copies.** `RunResult.steps[].result` (in memory, fine) → the run
   record on the task object (`putRecord`, a Durable Object `storage.put` — 128 KiB per value) → the
   checkpoint's `executed.completed[].result` on every suspension. A catalog search returning 50 items
   with descriptions is one step; a fan-out over 25 members is 25. The DO copy is a rebuild by doctrine,
   but a rebuild that fails to write (a value over the limit is refused) is a run that cannot resume.
3. **A re-plan and a resume re-read everything.** `PlanInput.observations` hands the planner the whole
   prior observations on a re-plan; a resume hands the loop every completed result. Neither needs the
   body of a 40 KB result to decide what comes next — they need what it was and where it is.
4. **Sub-work already runs elsewhere** (376 hand-offs, 380 fan-out consult, 366 routed steps) — but its
   result comes back whole into the parent's observations, so the parent's context grows with every
   delegate's output.

## 1. The rule, stated once

**A step's full result belongs to the turn that produced it; what OUTLIVES the turn is a reference.**
A large result is written to the acting agent's vault as a receipted artifact (`run.artifact:<runRef>:<stepRef>`)
and everywhere the run is kept or reasoned about after the fact — the record, the checkpoint, a re-plan's
observations, the composer's evidence past its budget — the observation carries **an `ArtifactRefV1`
and a deterministic summary** instead of the body. The reply of the turn itself, and `$ref` threading
within the turn, still see the whole result: offloading changes what is *stored and shown to a model
later*, never what a tool returned to the step that asked. A resume rehydrates a referenced result
from the artifact only when a later step's `$ref` needs it. Nothing here is a model summary: the
summary is a shape (keys, counts, the first titles) computed the same way every time, so a checkpoint
and its replay agree byte for byte.

**And nothing is cut silently.** The composer's evidence is *fitted* to its budget by a documented
order that records every drop on the trace (`composerEvidence: { chars, of, dropped[] }`), exactly as
`fitPlannerPrompt` does for the planner — a summary stands in for a body, and the governor is told
which results it is judging a claim against.

## 2. The pieces

| Piece | Delivers | Where |
| --- | --- | --- |
| **`ArtifactRefV1`** | `{ $artifact: 'ap.artifact-ref.v1', agent, recordType, digest, bytes, toolId, summary }` — the stand-in for an offloaded result. `digest` is sha256 of the canonical JSON (the receipt's `outputDigest` commits to the same bytes); `summary` is `summarizeResult(result)` | `orchestration/src/artifacts.ts` |
| **`summarizeResult`** | deterministic, bounded (≤ 600 chars): the value's kind, top-level keys, array lengths, the first three items' `title`/`name`/`id`, a numeric `count`/`total` when present. Never a model, never a free-text field's body | same |
| **`isArtifactRef` / `OFFLOAD_THRESHOLD_CHARS`** | a result whose canonical JSON exceeds the threshold (default 8,000 chars; app-tunable) is offloaded when a store is bound | same |
| **`ArtifactStore` port** | `{ put(runRef, stepRef, toolId, result) → ArtifactRefV1; get(ref) → unknown }`. Bound by the app to the acting agent's own vault door (write through `writeSubjectRecord`, read through `readSubjectRecord`) — the same door the provenance record uses (ADR-0055) | app `artifact-store.ts` |
| **`offloadObservations(result, store)`** | the record / checkpoint form of a run: every observation over the threshold replaced by its ref. Pure over the store's answers; the receipts are untouched (their digests already commit to the full output) | `orchestration/src/artifacts.ts` |
| **`rehydrateObservations(completed, store)`** | the inverse on a resume, applied only to results a later step's `$ref` reaches (the loop's `resume.completed[]`) | same |
| **`fitEvidence(observations, cap)`** | the composer's evidence, fitted: refs stay refs (their summary is the evidence); full results are kept newest-first while they fit; a result that does not fit is replaced by its summary; the drops are recorded. Both composers take `evidence` from the caller instead of slicing | `orchestration/src/artifacts.ts`; `orchestration-anthropic`, `orchestration-openai-compat` |
| **The vault record** | `run.artifact:<runRef>:<stepRef>` = `{ type: 'ap.run-artifact.v1', runRef, stepRef, toolId, digest, bytes, at, result }`, bound to `apexec:RunArtifact ⊑ prov:Entity` (new term; `apful:Artifact` is a fulfillment deliverable, not a step's raw output). Scope `vault:run.artifact:*` on the genesis plane, the Home's grant and the effect-writable list; existing demo grants re-issued | `ontology`, `genesis-planes.ts`, `delegation.ts`, `interactions-do.ts` |
| **PROV** | the step `generated` the artifact entity (`apexec:RunArtifact`, `ref` = the record key, `wasAttributedTo` the agent) — the graph names where the body is, a reader with the grant fetches it | `orchestration.provenanceOf` view + `provenance.projectHarnessRunProvenance` |
| **Trace** | `PlannerTraceV1.composerEvidence` and `offloaded[]` (stepRef, bytes, recordType) | `harness-run.ts` |

## 3. Boundaries (the drift to refuse)

- **The turn sees the whole result.** `askReplyFor`'s `results` artifact, `$ref` threading within a run,
  the answer templates (371) all read `RunResult` — untouched. Offloading is applied at `recordOf` /
  the checkpoint / the composer's evidence, never inside the loop's invoker.
- **A summary is a shape, not a claim.** No model writes it. It carries counts and the first titles;
  a composer that needs more than the summary to answer says so (358 W3's governor holds it to the
  evidence it was given).
- **The artifact is the agent's record.** It lives in the acting agent's vault under the run's key,
  readable under that agent's grant — never in a DO, never in the KB (ADR-0040/0055).
- **No silent cut.** A composer is handed evidence that already fits; the slice goes away.
- **One threshold, stated.** `OFFLOAD_THRESHOLD_CHARS` is a deployment setting recorded on the trace,
  not a per-tool guess.

## 4. Waves + gates

| Wave | Delivers | Gate |
| --- | --- | --- |
| **W1** ✅ 2026-09-10 | `orchestration/artifacts.ts` (`ArtifactRefV1`, `summarizeResult`, `OFFLOAD_THRESHOLD_CHARS`, the `ArtifactStore` port, `offloadObservations` / `offloadRunResult` / `rehydrateObservations` / `refsReachedBy`, `fitEvidence`) · `ComposeInput.evidence` + `AnswerComposer.evidenceBudget`; both adapters fit instead of slicing · `apexec:RunArtifact` (+ `artifactBytes`, `artifactDigest`), the `run.artifact:` binding, `vault:run.artifact:*` on the genesis plane / the Home grant / the effect-writable list · the PROV projector emits the artifact as a `generated` entity · app `artifact-store.ts` over the vault doors; the record form at every record and checkpoint site (`/harness/ask`, the agent ask, a resumed commitment, a trigger); `rehydrateExecuted` on every resume; `RunRecordV1.offloaded[]`; `PlannerTraceV1.composerEvidence`. **Existing grants must be re-issued** for the new scope (`scripts/reissue-interactions-grants.mts <handle>`) — until then the write is refused, the body stays whole and the refusal is on the record | unit (`artifacts.test.ts`, `artifact-store.test.ts`, the adapters' cap tests): a 40-item result is offloaded to a ref whose summary names the count and first titles; the record form carries no body; a refused write leaves the body and reports; only a `$ref`-reached ref is rehydrated and a missing artifact is an error; the composer's evidence is fitted with the drops recorded and never sliced. **Live ✅** `verify-route.mts` (alice, "list every organization…"): the 8,789-byte `kb.question` result → `run.artifact:<runRef>:s0` written to alice's vault, the record's step result is the reference (`object{answered,count,interpretation,query,results}; count=46; results[46]`), the graph keeps all its members, the reply unchanged. The gateway study (`ligonier.svc`) offloads the same way once its grant carries the scope |
| **W2** ✅ 2026-09-10 | `compactObservations` — a re-plan's `PlanInput.observations` carry a body only under the threshold; over it, the summary (a reference keeps its own). The record listing carries `offloaded[]` as the record does | `artifacts.test.ts`: the planner sees `[summary: object{…}; count=40 …]`, never the body |
| **W3** ✅ 2026-09-10 | sub-work offloads by the same rule at the PARENT — a routed step's, a hand-off's, a fan-out item's result is a step result. What a projection reads off a result (`txHash`, `via`, `count`, `total`, `ok`, `outcome`) is RETAINED on the reference (`ArtifactRefV1.retained`, `resultFactsOf`), so offloading a body loses no evidence: the spans still link the routed run, the graph still names the receiver and the transaction | `artifacts.test.ts`: a 60-member routed roster and a 9 KB payment result offload; the record form still projects the `routed_to` link, `delegatedTo`/`delegatedToRun` and the tx hash |

## 5. Not this

Not a model-written summary (a summary that can be wrong is a second knowledge plane). Not a cache
(the artifact is the record; the DO copy of the run is still the rebuild). Not compaction of the
person's conversation memory (370 P7 keeps its own bounded window). Not a change to what a tool may
return.

## Reference: patterns to port

Deep Agents' filesystem offload (`write_file` of large tool outputs, a reference in the message) and
LangGraph's message trimming — diverged on: the artifact is a receipted vault record under the agent's
grant, not a scratch file; the summary is deterministic, not a model's; and every drop is on the trace.
`smart-agent` has no equivalent.
