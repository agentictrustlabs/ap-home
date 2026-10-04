# Spec 352 — The Ask capability program: conversational, authority-aware action

**Status:** draft (2026-09-04) · **Depends on:** [spec 350](350-authority-aware-agent-harness.md)
(harness, §3.5 prompt primitive, §3.6 `MandateRequirement`), [spec 351](351-agentic-primitives-substrate-program.md)
(substrate program, waves A–G), spec 336 §8.3 (mandate = delegation), [spec 340](340-agentic-interaction.md)
(`apix:` interactions), [ADR-0021](../docs/architecture/decisions/0021-generic-packages-vs-white-label-apps.md)
(vertical content stays in apps), [ADR-0025](../docs/architecture/decisions/0025-related-agents-are-private-vault-credentials.md)/[ADR-0040](../docs/architecture/decisions/0040-knowledge-base-only-public-onchain-data.md)
(private vs public context), [ADR-0055](../docs/architecture/decisions/0055-vaults-are-the-canonical-system-of-record-for-content.md)
(vaults are the record).
**Drives:** `docs/architecture/agentic-framework-competitive-analysis.md` §7 — every feature here closes a
named competitive gap, and no gap is worked unless an ask needs it (§6).

---

## 0. The product

The Ask surface is a conversation that does what the buttons do (350 §3.5). This spec turns that rule into
a product program by naming the two flagship conversations, decomposing each sentence into the substrate it
exercises, and sequencing the build so each wave ships **a conversation a person can have** — not a port a
developer can admire.

### 0.1 The two flagship asks

**Ask A — send money to a person I know.**

```
me:    send Alice 10 dollars
agent: Sending Alice Jones (alice.me, in your Riverside workspace) 10 USDC from your account. Is that ok?
me:    yes                     (the Home has me sign the mandate — the "yes" is a signature, not a chat token)
agent: Done — 10 USDC to alice.me. Receipt r-… (tx 0x…).
```

**Ask B — report something that happened.**

```
me:    had a baptism today
agent: Great news — Calvary is doing great works. Can I add that to Calvary Church's baptism numbers?
me:    yes
agent: Recorded. Your report is in your vault; Calvary's agent has accepted it into the 2026 count. Receipt r-….
```

Neither sentence names a tool, a payload, or a call sequence — they are **goals** (ADR-0044). Everything
between the sentence and the receipt is this program.

### 0.2 What one sentence requires (the honest inventory)

*"Send Alice 10 dollars"* exercises, in order: ask intake on the person's A2A agent · intent classification ·
**entity resolution of "Alice" against MY private context** (vault relationships, team/org/workspace
rosters — never a global search, ADR-0025) · amount normalization (`$10` → 10 USDC on the named chain) ·
plan preview composed as a confirmation sentence · mandate assembly (my SA → harness SA,
`DigestBindingEnforcer` + `PaymentEnforcer` payee/ceiling/nonce caveats) · the §3.6 `MandateRequirement`
round-trip (the surface has me sign) · per-step verify · `redeemDelegation` · signed receipt ·
conversational close.

*"Had a baptism today"* swaps the middle: classification to a report, target resolution to an org I belong
to, and an A2A exchange with the org's agent whose **own policy** decides whether a member's report
auto-accepts or waits for a steward.

The competitive point (analysis §3): every framework can render this chat. None can make the "yes" a
signed, intent-bound, on-chain-revocable, replay-proof authorization — ours is, and was live 2026-09-03 for
the treasury variant.

---

## 1. What exists vs what this spec adds

**Already live (350 W1–W3, faithchain 2026-09-03):** `POST /harness/ask` with a durable checkpoint in the
asked agent's `A2aTaskDO` and `mergeTurn` resume; the `InputRequired` prompt primitive (`data` /
`signature` / `confirmation`); `MandateRequirement` (the run says what authority it lacks; the Home signs);
`DigestBindingEnforcer`; the treasury payment with second-party approval, wrong-intent DENIED, replay
REVERTED; team-create with credential + signature prompts; `treasury.fund`, `organization.create`,
`organization.membership.invite`; `normalizeArgs` as the one place a person's words become canonical values.

**This spec adds, in program order:**

| # | Feature | New? | Owner |
| --- | --- | --- | --- |
| **F1** | **Ask intake + intent classification** — utterance → `AskClassification` (capability candidates + confidence; *clarification-required* when ambiguous) | new port in `harness`; LLM binding in `orchestration-anthropic` | 350 harness |
| **F2** | **Personal entity resolution** — "Alice" → SA address from **the asker's private tier** (vault relationships, rosters via delegated reads); typed; ambiguous ⇒ choice prompt; none ⇒ honest refusal | first consumer of the `context` package (351 P0.11) | `context` + `demo-mcp` |

**F2 — the typed suffix is what makes a bare name decidable (shipped).** "Send nathan a message" and
"send money to nathan" are the same word and two different agents. The difference is not in the sentence:
it is in the CAPABILITY, and the typed suffix names the derived agent type (ADR-0061), so a capability
declares which types its party arguments mean — money moves between `.treasury` and `.org`, an inbox
belongs to `.me` first, an invitation is issued by an `.org`/`.team` and received by a `.me`. The
declaration is ORDERED and read as tiers: the first type anything answers to wins.

This is a narrowing, never a ranking. Two candidates of the same preferred type is still a question; a
capability that has declared nothing narrows nothing (silence is not a preference); and when nothing
answers to the preferred types the person is asked with everything that DID answer, so "nathan has no
treasury" arrives as an answer rather than as a silent substitution of some other Nathan. What it chose is
shown on the authority card before anyone signs — a rule that picks quietly is only as good as the
person's ability to catch it being wrong. Proved in `scripts/verify-typed-parties.mts` and seven unit
cases in `apps/agent-runtime/test/party-resolution.test.ts`.
| **F3** | **Person-to-person payment** — `person.payment.send`: delegator is the PERSON's SA (the live scenario's delegator was a treasury); same enforcer stack | capability + scenario, no new contract | `delegation` ✅ + `demo-a2a` |
| **F4** | **Confirmation-as-signature** — for risk ≥ high the confirmation IS the mandate-signing ceremony (§3.6); a chat "yes" alone never authorizes (Pydantic's boundary, analysis §2.8) | UX contract + gate test | `demo-a2a` + Home |
| **F5** | **Report/record capability** — `organization.report.record`: a member's signed report lands in the MEMBER's vault; an A2A exchange offers it to the org; the org's policy accepts (append to its metric record) or asks its steward — the pending→accepted situation pattern | new capability, `apix:` exchange profile | `fabric`/`a2a` + `demo-mcp` |
| **F6** | **Vertical vocabulary via white-label config** — "baptism", "Calvary" are app-layer labels over the generic metric record (`kind: <app-configured>`, `count`, `period`); packages never carry them (ADR-0021) | config schema | app layer |
| **F7** | **Amount + asset normalization** — `"$10"` → `{token, amount, chain}` shown verbatim in the confirmation and pinned verbatim in the caveat; no silent conversion after signing | pure function + test | `harness` |
| **F8** | **Conversational close over receipts** — the reply is composed FROM the receipt (tx hash, receipt id), never from the plan | small | `harness` |

---

## 2. The Ask pipeline (stages, owners, refusal points)

```
utterance
  → F1 classify        (capability candidates; clarification-required if <1 confident)
  → F2 resolve         (typed subjects from the private tier; choice prompt on ambiguity)
  → plan               (350 planner; steps carry StepRiskClass)
  → preview            (confirmation composed from the RESOLVED plan — names and amounts exact)
  → authority          (mandate present? verify. absent? MandateRequirement → surface signs → resume)
  → execute            (per-step verify → invoke → receipt; prompts may suspend/resume; ADR-0013 on resume)
  → close              (F8: answer from receipts)
```

Refusals are **stage-local and honest**: an unresolvable name ⇒ *"I don't know an Alice in your teams,
organizations or workspaces"* (not a global search — ADR-0013, one mechanism); a missing mandate ⇒ the
requirement, not a guess; an unmet policy floor ⇒ the obligation named. A different question never rides an
existing run's mandate (350 W3 — it would fail `intent-mismatch`; we say so up front).

Every stage is a port already named by 350/351 — this spec adds no new plane. **Endeavor** enters only when
an ask fans into between-agent work with its own lifecycle (a reporting campaign across congregations, a
rollup) — then the ask creates an Endeavor (ADR-0054); a single report exchange (Ask B) is one
`apix:Interaction`, not an Endeavor.

---

## 3. Flagship scenario A — `person.payment.send`

| Step | What happens | Substrate |
| --- | --- | --- |
| 1 | Home posts the utterance to MY agent's `/harness/ask` | `A2aTaskDO`, checkpoint |
| 2 | F1 classifies → `person.payment.send` (high) | harness |
| 3 | F2 resolves "Alice" in my private tier → `alice.me` `0xc35c…`; two Alices would choice-prompt | `context` |
| 4 | F7 normalizes → 10 USDC, faithchain | harness |
| 5 | Preview: the exact sentence of §0.1; the run suspends on confirmation | 350 §3.5 |
| 6 | No mandate yet → `MandateRequirement`: my SA → harness SA, caveats `DigestBinding(intent)` + `PaymentEnforcer(payee, ceiling, nonce=f(intent))` + `AllowedTargets(USDC)` | 350 §3.6 |
| 7 | Home renders ONE ceremony: the confirmation and the mandate signature are the same act (F4) | Home |
| 8 | Resume: verify (unrevoked, digest matches, ladder satisfied — high ⇒ a second party only if MY policy record demands one for personal sends; default: the signer IS the principal) | harness + chain |
| 9 | `redeemDelegation` → transfer; receipt signed, vault-resident; anchored when `ReceiptAnchorRegistry` lands (351 B) | chain + `verification-receipts` |
| 10 | Close from the receipt | F8 |

**Negative twins (CI, faithchain):** same mandate + *"send Alice 100 dollars"* ⇒ `PaymentEnforcer` ceiling
revert · replay ⇒ `NonceReused` · revoke between 8 and 9 ⇒ step refused · *"send Bob 10 dollars"* on
Alice's mandate ⇒ `intent-mismatch` · **a chat "yes" with no signature ⇒ the run stays suspended and
nothing moves** (F4's claim).

---

## 4. Flagship scenario B — `organization.report.record`

| Step | What happens | Substrate |
| --- | --- | --- |
| 1–2 | Utterance → classified as a report; F2 resolves the target org: I belong to Calvary (private tier); two candidates would choice-prompt | harness + `context` |
| 3 | The app's white-label vocabulary maps "baptism" → a configured metric kind (F6); packages see only `{kind, count: 1, occurredAt}` | app config |
| 4 | Preview/confirmation: the §0.1 sentence — warm phrasing is app voice config, the FACTS come from the resolved plan | F8 discipline |
| 5 | On yes: my agent writes a signed `ContributionReport` to MY vault (my testimony, mine to carry — ADR-0055) | `demo-mcp` |
| 6 | My agent sends one `apix:` exchange to Calvary's agent offering the report (profile `report-offer`, pinned version + context snapshot) | `a2a` + `fabric` |
| 7 | Calvary's agent, under ITS policy record: member-self-report auto-accepts (append + acceptance receipt) or suspends into its steward's approval queue (351 P0.5) — pending situation → accepted record | org harness |
| 8 | The acceptance receipt flows back; my run closes: *"…accepted into the 2026 count"* — or honestly: *"Sent to Calvary — their steward will confirm"* | F8 |

**Negative twins:** I'm not a Calvary member ⇒ resolution refuses at step 2 (no org write attempted) ·
Calvary's policy requires steward approval and none comes ⇒ timeout auto-deny, reported honestly · a second
identical report the same day ⇒ idempotency key (reporter + kind + occurredAt) makes the append a no-op,
receipted as such.

**Risk class: medium** (reversible — the org can remove a count), so no signature ceremony; the confirmation
prompt suffices. The write authority is the org's OWN agent under the org's OWN policy — my agent never
holds a mandate to write Calvary's records; it holds only the standing to *offer* (membership, checked by
Calvary's gate). That split is the vault-and-ontology rule working.

---

## 5. Gap-closure ledger (the competitive spine)

**Rule: no gap is worked without an ask that exercises it; no ask ships without closing its gap.**

| Competitive gap (they lead) | Ask feature that closes it | Wave |
| --- | --- | --- |
| Context providers as a contract (MAF) | F2 — the `context` package's first consumer; the contract ships because "Alice" must resolve | 351 C |
| Durable approvals surviving restart (Dapr) | Ask B step 7: the steward's queue on the org's `A2aTaskDO`; kill-DO-mid-approval test | 351 B |
| Checkpoint/resume (LangGraph) | already live (350 W3); this program adds the multi-turn CI proof | ✅ + B |
| Receipts a third party can verify (nobody) | F8 closes from receipts; anchoring lands in 351 B | 351 B |
| Human-in-the-loop argument inspection (LangGraph/Strands) | F4/F5 confirmations render the RESOLVED plan — inspection IS the preview | Ask-1 |
| Intent-bound authority (our lead — extend it) | F3 extends the proven treasury flow to person-SA delegators; F4 makes the boundary a UX contract | Ask-1 |
| Eval/replay (LangSmith) | each twin in §3–4 becomes a §7.9 authority-set case | 351 F |
| TS DX / conversational polish (Mastra) | F1/F7/F8 — deliberately last-mile, never authority | Ask-1 |

---

## 6. Waves (aligned to 351)

| Wave | Ships (a conversation, plus its substrate) | Gate |
| --- | --- | --- |
| **Ask-1** (with 351 A) | Ask A end-to-end on faithchain: F1, F2 minimal (exact name + roster lookup), F3, F4, F7, F8 | §3 table + all five twins green in CI |
| **Ask-2** (with 351 B) | Ask B end-to-end: F5, F6, the org policy auto-accept path + the durable steward-approval path; Ask A's receipt anchored | §4 table + twins; kill-DO-mid-approval passes |
| **Ask-3** (with 351 C) | F2 full: fuzzy resolution over the context ports, disambiguation prompts, typed refusals ("a wrong ontology type is a refusal") | the Somali/Weld ask (351 P0.11) AND "send Alice…" share ONE resolver |
| **Ask-4** (with 351 F) | every twin promoted into the evaluation authority set; replay re-derives the verdicts | authority set green in CI as replayed scenarios |

### 6.1 Where today's code stands against F2 — a correction this spec makes

`party-resolution.ts` (shipped 2026-09-04) already turns *"send 2 usdc from nathan to alice"* into an
address, with the three outcomes this spec wants: certain · ambiguous ⇒ choice prompt · unknown ⇒ ask. But
it looks in the **wrong tier**: typed roots on chain, then the PUBLIC directory. §0.2 and §7 are explicit
that "Alice" resolves in the asker's **private** context or refuses — a global search is a different ask
(279/338), and a public directory hit is not evidence that this person knows that Alice.

So Ask-1's F2 is not new code so much as a **re-pointing**: the same resolver, reading the asker's
relationships (vault) and rosters (delegated reads) through the `context` ports, with the public directory
demoted to the discovery ask where it belongs. The prompt-on-ambiguity behaviour carries over unchanged —
it is the part that was right.

---

## 7. What this spec does NOT add

- **No NLU framework.** F1 is one port + the existing Anthropic binding; classification confidence is an
  implementation detail, never authority (a misclassification is caught by `intent-mismatch`, by design).
- **No new authority mechanism.** A mandate is a delegation (336 §8.3); "confirmation-as-signature" is UX
  over §3.6, not a new gate.
- **No global people search.** "Alice" resolves in MY private tier or refuses.
- **No faith vocabulary in packages** (ADR-0021). The metric record is generic; "baptism"/"Calvary" arrive
  via app white-label config.
- **No chat memory as authority context.** Prior turns inform phrasing; every run's authority is its own
  mandate against its own intent digest.
- **No second storage home.** Reports and receipts are vault records; the DO keeps only checkpoints and
  queues (ADR-0055's rebuild-vs-bereavement test).

---

## 8. Reference: smart-agent patterns to port

Checked `/home/barb/smart-agent` (branch `003-intent-marketplace-proposal`): its delegation/session patterns
are already ported (209/270); it has **no** conversational-ask surface, **no** entity-resolution tier and
**no** report/metric exchange — deliberate divergence, consistent with 350 §13. The conversational
references are external: Mastra for TS DX, LangGraph interrupts for the suspend/resume shape (already ours
via `A2aTaskDO`), Pydantic's approval-boundary warning as F4's justification.

---

## 9. Open questions

1. **Asset default** — `"$10"` with no token named: default to USDC-on-faithchain per app config, always
   shown in the preview? *(Proposal: yes; a signed confirmation over the exact token is the consent.)*
2. **Personal-send ladder floor** — is `person.payment.send` high (signature every time) or amount-tiered by
   MY policy record (≤ $20 medium)? *(Proposal: tiered by the person's own vault policy; floor never below
   medium.)*
3. **Report acceptance semantics** — does the org's metric record store the count, or references to member
   `ContributionReport`s with the count derived? *(Proposal: references — provenance survives; the count is
   a projection.)*
4. **Alice's consent to receive** — does a first-ever payment to Alice require her agent's payment-accept
   exchange (336 engagement), or is an on-chain transfer to her SA unconditional? *(Interacts with 338's
   find ≠ use.)*
