# Spec 385 — Scoped confirmation memory: a confirmed choice is evidence about a choice, never permission

**Status:** W1 ✅ 2026-09-08 · **W2 ✅ shipped + LIVE on faithnet 2026-09-09** (§4 — the pick-then-remember path proven end to end on alice's own estate; demo-a2a-faithnet 6c9eff18) · **Kind:** Context/memory primitive (spec 367 W5 / appendix N4) — a durable, context-scoped preference in the person's own vault, read by the party resolver
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
| **the pending scope** | when the resolver raises a choice prompt, the checkpoint's `awaiting` carries `{ word, capability, arg }`; the resume that answers it is the trusted event the ask route writes from | `apps/agent-runtime/src/harness-runs.ts`, `harness-run.ts`, `index.ts` |

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
| **W2** ✅ 2026-09-09 | the live pick-then-remember path on the Home; the Home shows a person their remembered choices and lets them clear one (correctable in the open); confirmation preferences carried in the portable-Home export. **Shipped:** `vault:confirmation.preferences` added to the interactions grant (Home `delegation.ts` + the a2a parity twin `GENESIS_INTERACTIONS_SCOPES`) and to the DO's `EFFECT_WRITABLE_RECORDS` — **W1's write could never land live: the record was in no grant scope and no allow-list**, and the fire-and-forget write logged "not kept" where nobody read it. A demo persona re-issues with `scripts/reissue-interactions-grants.mts <handle>` (additive scope; older grants deny the record until re-signed). `POST /harness/confirmations` (list, session-holder's own vault, no addressee — a preference belongs to the person, not the room) + `POST /harness/confirmations/forget` (`forgetConfirmation`, same in-Worker door the memory is written by). Home: the Ask flyout's collapsed "I remember N choices you made" line, one row per scope (word → agent as ARG when you CAPABILITY-WORDS) with **Forget**; refreshed after every turn. The write now names the agent (`nameOf`) — the surface answers with an address and the resolver reports no label for it. Portable Home: `record.get confirmation.preferences` in the op catalog + `portable-home-acceptance.mjs`. **Two truthfulness fixes the live gate forced:** (1) a ROUTED step (spec 366) is judged at the subject's agent, which was handed addresses and answered with its own parties ("0x1659… — said"), so the asker's citation vanished from the reply — the relay now keeps this run's own record (words, label, hint) for every agent it resolved itself; (2) an `answer` carries no parties, so a read's memory citation now rides the planner trace's binding as `because` (the Home's How pane). | `scripts/verify-ask-confirmation-memory.mts` (`ASK_PLAN=1` while no planner is reachable: Anthropic had no credit and Groq's free tier caps the prompt; the plan is what the Home's buttons send, and the resolver is the same) — LIVE as alice 2026-09-09: "invite bob to thompson" → "Which “thompson”?" (big-thompson-team.org / rich-big-thompson-team.org) → picked → `authority_required`, nothing presented; listed as `thompson → big-thompson-team.org as org when you invite members`; "invite carol to thompson" → no question, cited *remembered: you chose “big-thompson-team.org” for this before*, `authority_required` again; "who is in thompson" (a different capability) → not the invite's memory — the binding says *remembered: the “thompson” you chose last time* (the rolling window, word-scoped by design); Forget → the durable memory is gone and nothing writes it back; the window still answers, saying so, until it decays and the question returns. **Repeatability note:** the rolling window (370 P7, 12 turns) settles a word it saw settled BEFORE any question, so the gate reads the person's own `conversation.recent` (owner session) and asks a word the window does not hold (`somali corridor team` / `rich` / `thompson`); three different invitees, because re-sending the SAME sentence re-enters the unfinished run and its checkpoint, proving the checkpoint rather than the memory. The stale twin (contact removed ⇒ asks again) is the unit gate's revalidation case; no live estate link was removed for it. |

## Reference: patterns to port

- Browser autofill remembers what you typed into a field and offers it back, scoped to the field and revalidated
  against the form — it never submits for you. This is that, scoped to (word, capability, argument) and living in
  the person's vault: a shortcut through a question, never a grant, and always the person's to correct.
