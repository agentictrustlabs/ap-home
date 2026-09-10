# Spec 394 — Standing instructions: a declared default is evidence about a default, scoped by the room you stand in, never permission

**Status:** W1 ✅ · W2 ✅ 2026-09-10 (live: `verify-standing-instruction` + `verify-standing-instruction-room` in the nightly ledger) · **Kind:** Context/memory primitive (harness-feature-priorities Tier 2.1 — "standing-instructions memory record; acting-context namespacing beyond confirmations") — one vault record in `@agenticprimitives/context`, one resolver seam, one self-acting Ask capability, two routes, a Home panel row · **Grounds:** [spec 385](385-scoped-confirmation-memory.md) (the pattern: scoped, revalidated, cited, correctable, never a grant; written only from a trusted event), [spec 358](358-semantic-context-plane.md) W5 (vault-resident memory, `preference:*`), [spec 363](363-decision-plane.md) (the decision plane — a default is decided by ordered rules over modelled bases, or asked), [spec 353](353-app-scoped-ask.md) (the acting context: scope is honesty, the mandate is authority), [spec 367 §10](367-behaviour-plane-first-time-right.md), ADR-0041, ADR-0055

## 0. The gap

Three memories exist and none of them is the one a person reaches for most. The learned shorthand (358 W5)
answers *what a WORD means* ("alice" → alice2.treasury). The confirmation memory (385) answers *which one you
CHOSE for a word in a place*. The rolling window (370 P7) answers *whom you just meant*. What none of them holds
is a default with **no word in it at all**: *from now on, pay from alice3.treasury*; *when I am acting for Missio
Nexus, invitations come from the organization*. Today "send nathan 1 USDC" with two treasuries asks *which
account?* every time unless the person has published an on-chain `ap:primaryPayer` role — a public statement,
for a private habit. And every memory is keyed as if the person were always standing in the same room: "David"
chosen while acting for Missio Nexus settles "David" at home too.

## 1. The rule, stated once

**A standing instruction is the person's own DECLARED DEFAULT for one argument of one capability, scoped to the
room they were standing in when they said it, and it authorizes nothing.** It fills an argument the person did
not speak — never one they did. It is written only from a trusted event: the agent reads the instruction back
in words and the person's supplied *yes* on that resume is the write; a model asserting "the user wants" writes
nothing. It is revalidated at every use — the default must still be one of the agents the person could name
for that role now — or it is ignored, and it is cited on the binding (`source: standing`) so the person can see
why the payer was chosen and say otherwise. It is correctable in the open (listed, cleared) and lives in the
person's own vault. No verifier reads it: the mandate for the act is asked and signed exactly as if nothing
were remembered.

**The acting context is a namespace.** A confirmation (385) and a standing instruction both carry the context
they were made in — `any` at the person's own agent, the organization's address when the ask was addressed to
it — and are read for the same context first, then for `any`. A default declared for Missio Nexus is not the
default at home; a default declared at home applies everywhere the person has not said otherwise.

**Precedence for an unspoken acting party:** spoken value → standing instruction (this context, then `any`) →
the decision plane's modelled bases (the on-chain `primaryPayer`, 363) → the person's single agent of the
role's kind → ask. A private, context-scoped statement outranks a public general one because it is the more
specific answer the same person gave; both are evidence.

## 2. The shape

| Piece | What | Where |
| --- | --- | --- |
| **the record** | `StandingInstructionsV1` (`standing.instructions`, the person's own vault): entries `{ context: 'any' \| <address>, capability, arg, value, label?, saidAs, at, runRef? }`, keyed by `context ∷ capability ∷ arg`, newest wins, capped | `packages/context/src/standing.ts` |
| **the read** | `standingFor(rec, { capability, arg, context })` — the exact context, then `any`; `declareInstruction` / `forgetInstruction` pure | same |
| **the resolver seam** | `PartyLookups.standingInstruction?({ capability, arg, context })`; consulted in `resolveStepArgs` for the ACTING party when it was not spoken, before the decision plane; revalidated against `ownAgentsOfType` for the role's kinds; `ResolvedParty.via: 'standing'` → binding `source: 'standing'`, hint *your standing instruction: "…"* | `packages/context/src/party-resolution.ts`, `apps/demo-a2a/src/harness-run.ts` |
| **the declaration** | Ask capability `context.instruction.declare { capability, arg?, value, context?, forget? }` — self-acting like the household record (`selfAuthorized`, risk low, no mandate: it is a note in the person's own vault); the invoker reads the instruction back as a `data` prompt with a yes/no choice; the resume that supplies *yes* writes the record | `harness-run.ts` (tool + `standingInstructionInvoker`) |
| **acting-context namespacing** | `ConfirmationEntryV1.context?`; `rememberConfirmation` takes the context the ask ran in; `preferredChoice` reads the exact context, then the context-less entry | `packages/context/src/confirmation.ts`, `index.ts` (the write site) |
| **routes** | `POST /harness/instructions` (the session holder's own, with `capabilityWords`), `POST /harness/instructions/forget` | `index.ts` |
| **Home** | the Ask flyout's "I remember …" panel lists standing instructions beside remembered choices, each with Forget | `home/ask.ts`, `AskFlyout.tsx` |
| **ontology** | `apctx:StandingInstruction ⊑ prov:Entity` (+ `instructionCapability`, `instructionArgument`, `instructionValue → ap:Agent`, `instructionContext`, `declaredAt`) and — owed since 385 — `apctx:ConfirmationMemory` (+ `confirmedParty`, `confirmedWords`, `confirmedFor`); both bound in `vault-records.ts`; party roles for the declaration's `holder` (acting) and `value` (context, any agent) | `tbox/context.ttl`, `src/vault-records.ts`, `src/party-roles.ts` |
| **the three lists** | `vault:standing.instructions` in the Home's grant (`delegation.ts`), the a2a parity twin (`GENESIS_INTERACTIONS_SCOPES`) and the DO's `EFFECT_WRITABLE_RECORDS` — the 385 lesson: a record in no list never persists | `delegation.ts`, `genesis-planes.ts`, `interactions-do.ts` |
| **contract** | `person-standing-instruction` (`mandateRequired: false`) attached to `person-steward` + `person-steward-runtime` | `~/skills` |

## 3. Boundaries (the drift to refuse)

- **Never a grant, never a skipped step.** A standing instruction fills a value; the mandate is asked and signed
  as always. "Don't ask me to approve payments under 5" is not an instruction this record can hold — that is a
  caveat on a mandate the person signs, and the ladder is not the person's to lower by talking.
- **Never over a spoken value.** The person who says "pay from alice2" while holding a standing instruction for
  alice3 pays from alice2. The instruction is the answer to a question the sentence did not answer.
- **Only from the read-back.** The write is the person's supplied *yes* on the resume of the prompt that read the
  instruction back — the same trusted-event rule as 385. The planner's reading of "from now on…" writes nothing.
- **Revalidated, never stale.** A default naming a treasury that was deleted is ignored, not used; the question
  comes back.
- **Acting party only (W1).** A default for a counterparty ("always invite bob") is not a default, it is a
  different act each time; W1 fills the acting party (`authorityArg`) and nothing else.
- **The person's own vault; the person's own room.** No instruction is written into anyone else's memory, and
  none declared for one organization is read in another.

## 4. Waves + gates

| Wave | Delivers | Gate |
| --- | --- | --- |
| **W1** ✅ | the record + pure functions; the resolver seam and the acting-party fill with `via: 'standing'`; the declaration capability, its read-back prompt and trusted write; the routes; the Home panel rows; ontology classes + bindings (incl. the 385 debt); the three lists; the contract; confirmations carry their context | unit: `standing.test.ts` (declare / read for the exact context, then any / forget / a foreign context never matches / newest wins); `acting-party.test.ts` (an unspoken payer is filled from the instruction and cited `standing`; a spoken payer is left alone; a stale value — not among the person's own treasuries — is ignored; a default for another room is not read). **Live (no model, no spend)** `scripts/verify-standing-instruction.mts`: alice declares *pay from alice3.treasury* (supplied plan → read-back prompt → yes → listed); "send nathan.treasury 1 USDC" with no payer parks at `authority_required` naming alice3.treasury as the delegator with the payer binding `source: standing`; the twin: the same ask saying `payer: alice2.treasury` names alice2; Forget → the next ask does not name alice3 |
| **W2** | the acting-context twin live: a confirmation made while acting for Missio Nexus is not read at home (and vice versa); a standing instruction declared at the organization; the Home shows the room each memory belongs to | `verify-standing-instruction.mts --context` |

## 5. Not this

Not a shorthand (358 W5 keeps words), not a confirmation (385 keeps choices), not a rule engine (363 keeps the
ordered rules — an instruction is a fact its `standing` rule reads, not a rule of its own), not a caveat, not a
policy. Not a store any service holds a copy of.

## Reference: patterns to port

A mail client's "always send from this address when replying to work mail" — a per-account default, set once,
shown in settings, overridden by choosing another address on the message. Diverged on: the default is scoped to
the room (the organization the person acts for), is revalidated against the accounts they still hold, and is
cited on every use; and it never sends anything — the mandate does.

## W1 as shipped (2026-09-10)

- `packages/context/src/instructions.ts` (not `standing.ts` — that is spec 353's STANDING, a person's footing in an
  organization; this is what they INSTRUCTED): `declareInstruction` / `standingFor` / `forgetInstruction`,
  `STANDING_RECORD = 'standing.instructions'`, `ANY_CONTEXT`. Confirmations gained `context` (the same room first,
  then the room-less entry); the ask route writes the room it ran in.
- Harness: `context.instruction.declare` (self-acting, risk low) — the act is found by id, by its `CAPABILITY_WORDS`
  phrase or by a verb; the argument defaults to the act's `authorityArg`; the default resolves through an ontology
  party role (`value`, any agent); the instruction is READ BACK as a `keep` choice and written only from the supplied
  `yes`. `resolveStepArgs` fills an unspoken acting party from the instruction — revalidated against the person's own
  agents of the role's kinds — cited `via: 'standing'` → binding `source: 'standing'` (the receipt's `argSources`
  union widened). Routes `/harness/instructions` + `/forget`. The Home's flyout lists them beside remembered choices.
- Ontology: `apctx:StandingInstruction` and — owed since 385 — `apctx:ConfirmationMemory`, both bound in
  `vault-records.ts`; party roles for the declaration's `holder` / `value`. The three lists carry
  `vault:standing.instructions`; alice's grant re-issued; the contract `person-standing-instruction` on both person
  archetypes; alice's playbook re-pinned.
- Live (no model, no spend): the read-back → yes → listed; "send nathan.treasury 1 USDC" with no payer parked naming
  alice3.treasury with the payer binding `standing`; the spoken `alice2.treasury` stood; after Forget the payer came
  from the decision plane (alice2, her marked primary payer) — the precedence in §1, observed.
