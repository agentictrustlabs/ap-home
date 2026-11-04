# Faith intents in Home

Status: implemented; live acceptance evidence is recorded in docs/faith. Extends Church specs 200/201. Uses the existing AP runIntent harness,
AgentHarnessDefinitionV1, signed ask admission and subject vault port; no second coordination engine.
Smart-agent reference: canonical addressee binding in smart-agent/apps/a2a-agent/src/middleware/host-context.ts.

Home executes `faith.context.prepare` for a person and `church.context.prepare` for an organization.
The shared skills repository owns their SKILL.md contracts and ontology profile. Definitions compiled from those
artifacts supply the native person self-read and the organization's explicitly assigned church role. Neither installation nor an Ask grants vault access.
Church maintains organization source records; Seed edits personal records through the person's `person.faith.*`
intent acts. Their native ontology-shaped journey and prayer records are read directly by the person agent.
Additional personal sources and organization sources use a bounded, owner-held `faith.context:manifest` of
pointers and release rules written through existing authorized vault acts.
No private source text is copied into the manifest. Sources are read afresh through the addressee's own grant.

Requests name a question, intended recipients, purpose (`faith-ask`), and optional campus/date/passage scope.
These are a request, never authority. Manifest references apply release rules before fetching source plaintext.
Native faith records carry visibility inline: their own agent reads and validates that policy before any fields
reach another agent or an answer model. Only native `Open` records authorize the mixed collaboration audience;
restricted audiences and confidential records stay private. Care is excluded. Only the current stage is shared.
All named recipients AND the authenticated asker and app delegate must be allowed. Personal self access is necessary but
not sufficient for onward sharing. Private entries are never contributed. Public organization entries may be contributed;
personal manifest entries always require named recipients. Expired or revoked entries fail closed. Only approved scalar fields
are projected; arbitrary nested records, secrets and raw prayer bodies cannot escape through object serialization.
The manifest owner and role must match the addressed principal and chain role. An organization cannot read a person's
vault by supplying that person's address in tool arguments. Source records with owner metadata must agree with the vault.

Responses contain released evidence, exact source keys/field locators, truncation and coverage, skill source commitments,
and owner/recipient binding. The existing harness wraps them with its real run reference and performs normal grounded
answer composition for a conversational Ask; supplied-plan rowsOnly calls avoid unnecessary model calls. Retrieved prose
is evidence, never instructions. Incomplete data is stated and no age, faith maturity, current series, or missing prayer
is inferred. Scripture interpretation remains the ask-writings specialist's responsibility. Contribution mode never calls
another agent, preventing recursion; Church coordinates person + organization contributions before asking Scripture.

Acceptance: signed intent at each role; own-vault binding; denied/private/expired/malformed policy excluded before read;
all-recipient intersection; no source metadata leaks; current revision read; bounded evidence with locators; campus/date
scope; missing grant distinct from empty data; existing preferences and nonfaith asks unaffected; real Church integration.
