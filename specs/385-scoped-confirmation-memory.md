# Spec 385 — Scoped confirmation memory: a confirmed choice is evidence about a choice, never permission

**Status:** W1 ✅ shipped + deployed to faithnet 2026-09-08 (§4; the live ambiguity path is W2 — see the gate note) · **Kind:** Context/memory primitive (spec 367 W5 / appendix N4) — a durable, context-scoped preference in the person's own vault, read by the party resolver
**Grounds:** [367](367-behaviour-plane-first-time-right.md) §10 + W5 ("a confirmed choice is evidence about a choice, not permission … scoped, correctable, revalidated; never a fresh grant") · [370](370-harness-parity-ledger-and-program.md) P7 (the rolling conversation window + `chosenBefore`, which this outlives) · [358](358-semantic-context-plane.md) W5 (vault-resident memory, never a platform store) · [363](363-decision-plane.md) (a decision cites the fact it rests on) · ADR-0055 (the vault is the record) · ADR-0041 / [354](354-archetype-driven-agent-behavior.md) §1 (behaviour is generated; authority never is) · appendix N4 in [`harness-parity-gap-analysis.md`](../docs/architecture/product-comparison/harness-parity-gap-analysis.md)

## 0. The gap

P7 gave the harness a rolling 12-turn conversation window: ask "send David 20" twice in a session and the second
resolves to the David you picked the first time (`chosenBefore`, matched on the words and revalidated against the
current candidates). But the window decays — the thirteenth ask forgets — and it is scoped only to the WORDS, not
to what you were doing with them. "David" as a payment recipient and "David" as someone to invite are the same
window entry, and a preference you settled a week ago is gone. The behaviour plane (367 §10) asks for something
narrower and longer-lived: *for this person, resolving THIS word, AS THIS capability's THIS argument, the last
confirmed selection was X* — durable, scoped, correctable, revalidated, and, above all, never mistaken for a grant.

## 1. The rule, stated once

**A confirmed choice is remembered as EVIDENCE, scoped to (word, capability, argument), and it authorizes nothing.**
It is written only from a TRUSTED interaction event — the resume in which the person supplied the choice a prompt
asked for — never because a model wrote "the user confirmed". It is used to PREFILL or RANK the next ambiguous
resolution of the same word in the same place, and it is revalidated every time: the remembered agent must still be
one of the candidates the resolver found now, or the memory is ignored (a treasury that was deleted, a person who
left the household, is not silently reused). It is correctable — a new confirmation for the same scope replaces the
old — and it is cited, so a person can see why "David" resolved the way it did and say otherwise. No verifier reads
it; the mandate is still asked and signed exactly as if nothing were remembered.

## 2. The shape

| Piece | What | Where |
| --- | --- | --- |
| **the record** | `ConfirmationPreferencesV1` — the person's OWN vault record (`confirmation.preferences`, ADR-0055/358 W5), a bounded map keyed by `word ∷ capability ∷ arg` → `{ agent, label?, at, runRef }`, newest write wins (correctable), capped | `packages/context/src/confirmation.ts` |
| **the write** | `rememberConfirmation(prefs, { word, capability, arg, agent, label, runRef, at })` — pure; the caller (the ask route) invokes it ONLY on the trusted resume that supplied a choice a prompt raised | same |
| **the read** | `preferredChoice(prefs, { word, capability, arg }, candidates)` — the remembered agent IF it is still among `candidates` (revalidated), else `null`. Scope is exact: a different capability or arg does not match | same |
| **the resolver seam** | `PartyLookups.preferredChoice?(word, arg) => Promise<{ agent; label? } \| null>` — consulted in the ambiguity branches BEFORE the rolling `chosenBefore`, so a durable scoped preference outranks a decayed window; cited `hint: "remembered: you chose X for this before"` | `packages/context/src/party-resolution.ts` |
| **the pending scope** | when the resolver raises a choice prompt, the checkpoint's `awaiting` carries `{ word, capability, arg }`; the resume that answers it is the trusted event the ask route writes from | `apps/demo-a2a/src/harness-runs.ts`, `harness-run.ts`, `index.ts` |

## 3. Boundaries (the drift to refuse)

- **Never a grant.** A remembered choice prefills a value; the mandate for the act is asked and signed as always.
  Nothing here is presented to a verifier, and a preference can never widen, skip, or pre-authorize a step (ADR-0041).
- **Only from a trusted event.** The write is the person's own supplied choice on a resume — the same trusted
  interaction that P1 replays. A model asserting "the user confirmed" writes nothing (367 §10).
- **Revalidated, never stale.** The remembered agent is used only if the resolver found it among the current
  candidates this time. A memory is a shortcut through a question, never an answer the world no longer supports.
- **Scoped, not global.** The key is the word AND the capability AND the argument. "David" the payee and "David"
  the invitee are different memories; leaking one into the other is the drift this prevents.
- **The person's own vault, never a platform store.** Preferences live where the person's records live (358 W5),
  carried to another Home like anything else; no directory of other people's confirmations exists.

## 4. Waves + gates

| Wave | Delivers | Gate |
| --- | --- | --- |
| **W1** ✅ 2026-09-08 | the record + `rememberConfirmation` + `preferredChoice` (pure, in `context`); the `preferredChoice` resolver seam consulted before the rolling window (both ambiguity branches); the pending scope on the checkpoint's `awaiting`; the ask route writing a preference from the trusted resume; the read at the next ambiguous resolution, cited "remembered: you chose … for this before"; never a grant | unit `confirmation.test.ts` (a scoped write reads back for the SAME word+capability+arg and NOT for a different capability or arg; a remembered agent absent from the current candidates is ignored — revalidated; a newer confirmation replaces an older — correctable; an empty scope or non-address writes nothing) + the resolver seam typechecked and all 741 Worker tests green with it wired; **deployed** to faithnet (version 7a3e37f5). **The live ambiguity end-to-end is W2, and here is why:** the branch fires only on 2+ candidates for one word, and the faithnet demo estate resolves every payee word UNIQUELY (marked `primaryPayee`/`primaryPayer` accounts, single-match links) — there is no natural ambiguity to pick from, and manufacturing one means writing contrived duplicate-named records into the live estate, which the value rail and the estate's own hygiene rightly discourage. The Home (W2), where a person genuinely has two contacts of one first name, is where the pick-then-remember path is exercised live |
| **W2** | the live pick-then-remember path on the Home (two same-named contacts); the Home shows a person their remembered choices and lets them clear one (correctable in the open); confirmation preferences carried in the portable-Home export | a person picks among two "David"s once; the next ask resolves to the same one, cited, and still asks the mandate; **a stale preference (the contact removed) asks again; a different capability naming "David" does not inherit the payee choice** |

## Reference: patterns to port

- Browser autofill remembers what you typed into a field and offers it back, scoped to the field and revalidated
  against the form — it never submits for you. This is that, scoped to (word, capability, argument) and living in
  the person's vault: a shortcut through a question, never a grant, and always the person's to correct.
