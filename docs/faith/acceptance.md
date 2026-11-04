# Faith intent acceptance — 2026-11-03 (America/Denver)

The person and organization harnesses run in `apps/agent-runtime` in ap-home at `https://a2a.faithnet.io`.
The Home website is the setup/permission interface. This change does not edit its UI.

Runtime version: `33644938-489f-479b-8d9f-2d375bceb6cb`, deployed from master after PR #88 merged.
The native `person.faith.*` record capabilities from PR #87 are included. Worker names, bindings and migrations are unchanged.
Church workspace version: `d3e2d5cc-e01f-43f4-8b73-977072cd3277` (final remote-signing deployment and old-secret retirement).
Calvary domain agent version: `01ef88db-8706-4a17-b995-95dced7b2d07`.

## Final release browser evidence

[Church release evidence](https://github.com/agentictrustlabs/ap-church/blob/master/docs/collective-ask-flow.md#release-acceptance--2026-11-03-americadenver) records the post-merge acceptance:

- Fresh demo Carol connected, saved Calvary/Erie, reloaded and recovered her preference. Services took 19.3 seconds; her Philippians 3 ask took 35.9 seconds and returned 20 evidence items through distinct person, church and Scripture runs.
- A read-only assignment audit confirmed Carol had no manually installed faith-context tool; the native runtime offer worked without modifying her assignment.
- Bob received the stored November 1 three-campus comparison in Church mode (31.3 seconds). Alice received it in Scripture/writings mode with a real ask-writings run (45.9 seconds). All speakers and publishing links were present.
- Startup measured shell 222ms, identity 3,019ms, records 10,184ms. These are individual measurements, not uptime or latency guarantees.
- Remote delegate signing passed signature recovery and denied a disallowed signing purpose. The provisioning caller is disabled and the old raw Worker signing secret is removed. Existing sessions must reconnect for the new delegate.

The repeat test had one concurrent Connect verification failure and a transient runtime refusal before a sequential retry passed. Church now preserves the runtime error detail rather than replacing it with a generic error. Successful samples had no browser page errors.

## Earlier pilot browser evidence

See [browser-evidence.json](browser-evidence.json) for actual run references and source identities.

- Alice connected, saved Erie as the default campus, and received 8:00, 9:30 and 11:00 Sunday service times (28.2 seconds).
- Bob connected, saved Boulder, and received 9:00 and 10:30 service times (21.7 seconds), with a distinct person and run.
- Alice asked about Philippians 3:12–16. Person and organization context started concurrently; the church agent supplied
  current Erie sermon metadata and excerpts. The bounded 5,733-character packet reached the real ask-writings service.
  It returned 20 evidence items and a distinct Scripture run (35.6 seconds overall). The answer included Calvary's teaching;
  source attribution and model interpretation remain distinct. This is evidence of handoff, not independent verification
  of every model-generated claim.
- Bob asked to compare this week's three site messages. The stored November 1 comparison was returned with Boulder,
  Erie and Thornton speakers, sermon links, and its model-proposed/unreviewed qualification (32.5 seconds).
- No browser page errors in these checks. The demo accounts had no released faith-life records during these browser tests;
  existing reading preferences and church/campus context were used, without inventing a personal profile.

## Native personal-record check

[native-record-evidence.json](native-record-evidence.json) records a live signed-intent test of Seed's native writer:
an explicitly labelled Open stage contributed; a newer Confidential stage withheld itself and superseded public history;
all fixtures were removed and Alice's original assignment restored. The writer artifact was validated before assignment.
The companion journey-writer artifact's metadata now uses the current AP `submission` and `receipt` contract values.

## Checks

Runtime typecheck and deployment dry run passed. The complete runtime suite passed: 1,630 tests in 171 files.
The Home suite passed 961 tests. Import-heavy runtime suites now use a bounded worker pool alongside other packages.
Church typecheck, build and 112 tests passed. Shared skill definitions regenerate byte-for-byte and validate against AP;
its Turtle source parses (140 triples).

All enabled `ap doctor` rules pass. Credential issuance retains its exact mandate check and now also uses the standard
`subjectOfRead` gate. Rules projection, Home census, fixture coverage and estate shape pass. Custodian coverage remains
skipped by the existing repository configuration.

Calvary has the organization skill in its compiled playbook. The person contribution is a native read-only runtime capability backed by the compiled person skill, including for people with no manual faith-tool assignment. Source artifacts are
in [skills PR 41](https://github.com/agentictrustlabs/skills/pull/41). Signed corpus publication and graph loading are separate.
Native writers remain under Seed's role assignment and sharing UX. Person context preparation is a native read-only capability backed by the compiled skill; new people do not need a
manual playbook edit. Organizations still need the church role assigned. Both require adequate vault authority; this
code does not grant access. Open native prayers must also be relevant to the question; private and confidential records
are withheld before contribution or model composition.
