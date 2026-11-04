# Writer contract: faith context

The A2A runtime in ap-home executes the faith skills; the Home website is not the agent runtime.
Seed owns the personal editor and calls `person.faith.*` intent acts; the person's agent writes their vault.
Church owns organization editing. Neither app needs to copy source text into the other app.

Native personal records use the existing faith ontology and the actual Seed keys: `faith.journey-stage:*`,
`faith.milestone:*`, and `faith.prayer-request:*`. The contribution adapter reads at most 32 candidate records
inside the person's own agent and checks `@type`, `aboutSubject`, removal and inline `visibility` before
releasing scalar evidence. Only `Open` authorizes the mixed audience of app, church and Scripture agents.
`Confidential`, `Friends`, `BodyOnly` and `LeadersOnly` are not broadened by this collaborative Ask.
Only the latest stage assertion may contribute; a private latest assertion does not expose an older public one.
Care records and answered-prayer bodies are not included in general collaborative Ask. No extra manifest is needed
for these native records. Seed remains responsible for the person's sharing controls.

For organization data and additional personal sources, the implementation accepts a bounded manifest
(maximum 100 references) at `faith.context:manifest` in the owner's own vault, plus its referenced source records.
Use existing authenticated vault writes; this contract confers no write permission. Update sources before the manifest.
Use compare-and-set/revision conflict handling in the owning application's existing write path.

Canonical ontology: skills/ontology/faith-context.ttl. Skill contracts: skills/faith/person-faith-context/SKILL.md
and skills/faith/church-faith-context/SKILL.md. Home's generated definitions are reproducible with
`pnpm exec tsx scripts/compile-faith-context.mts <Home>/apps/shared/src/faith-skills.json` from skills.
These are local compiled artifacts; corpus publication and graph loading are separate and are not implied.

```json
{
  "@type": "https://ontology.faithchain.org/faith-context#ContextManifest",
  "owner": "0x1111111111111111111111111111111111111111",
  "role": "person",
  "version": 1,
  "revision": "app-owned-revision-1",
  "updatedAt": "2026-11-03T12:00:00.000Z",
  "entries": [{
    "recordType": "faith.prayer:stable-id",
    "class": "https://ontology.faithchain.org/incubator#PrayerRequest",
    "category": "prayer",
    "fields": ["/permittedSummary"],
    "release": {"visibility": "private", "recipients": [], "purposes": ["faith-ask"]}
  }]
}
```

Use `recipients` visibility only after the person chooses to release these fields. Recipients are exact canonical
agent addresses, INCLUDING the authenticated app delegate and every onward receiver. No wildcard, membership inference,
or automatic conversion from a private prayer to an ostensibly harmless summary. Public release applies to organization
records only. `revoked: true` or an elapsed `expiresAt` excludes a reference before reading its source.
The source must carry the declared `@type`; an `owner` field, if present, must match its vault.

Supported personal record prefixes: faith.journey:, faith.prayer:, faith.reading:, faith.preference:,
legacy church.journey:/prayer:/reading:, and typed content.artifact. Library records. Existing person.preferences
can release only /answer/language and /answer/style. Sources must expose selected scalar JSON Pointer fields.
Existing untyped Library bytes need a typed adapter record from Seed; they are never treated as verified faith facts.
Church supports church/campus/service/event/sermon/sermon-insight/podcast/community/group/study/serve/strategy/resource
records. Care cases, guide notes and credentials are outside this read adapter.

Call the same signed `/harness/ask` endpoint with a supplied plan containing `faith.context.prepare` (person)
or `church.context.prepare` (org). Arguments: question, purpose `faith-ask`, recipients as comma-separated addresses;
optional campusId, ISO date and passage. Use rowsOnly for a contribution, or normal grounded composition for an answer.
The person contribution is a native read-only capability backed by the compiled faith artifact, so newly connected people need no manual playbook installation. The organization capability must be composed into the organization's archetype.assignment. A missing organization manifest returns not-configured;
a denied vault read is an error, never an empty profile. Output supplies owner, recipients, current revision, bounded
source excerpts and field locators; the harness provides runRef. No contribution starts another agent call.

## Demo native-record acceptance

From the skills repository, generate both contributions plus the existing native journey writer:
`pnpm exec tsx scripts/compile-faith-context.mts /tmp/faith-definitions.json /tmp/faith-writer.json`.
Then from ap-home run `FAITH_WRITER_DEFINITION=/tmp/faith-writer.json pnpm exec tsx scripts/check-native-faith-context.mts`.
It validates and temporarily composes the writer into demo Alice's existing assignment, creates explicitly labelled
acceptance fixtures through `person.faith.journey.record`, checks Open and Confidential contributions, removes its
fixtures and restores the assignment. It refuses to overwrite a concurrent assignment change. It sends no messages.
