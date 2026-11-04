# Faith intent acceptance — 2026-11-03 (America/Denver)

The person and organization harnesses run in `apps/agent-runtime` in ap-home at `https://a2a.faithnet.io`.
The Home website is the setup/permission interface. This change does not edit its UI.

Runtime version: `ba077be8-718e-46be-af79-eb8ce9b5c632`, deployed after merging origin/master through PR #87
(the native `person.faith.*` record capabilities). Worker names, bindings and migrations are unchanged.
Church workspace version: `68e65a6b-6e0d-4dd5-ab84-d11e45155431`.
Calvary domain agent version: `33b8cd40-4595-4a36-8cef-e42bcecd58e8`.

## Live browser evidence

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

Runtime typecheck and deployment dry run passed. The complete runtime suite passed: 1,628 tests in 171 files.
The first full run had one unrelated import timeout; the rerun with four workers passed without changing the test.
Church typecheck, build and 109 tests passed. Shared skill definitions regenerate byte-for-byte and validate against AP;
its Turtle source parses (140 triples).

`ap doctor` retains one pre-existing failure in `credential-issue.ts` (`no-cross-subject-vault-reads`), reproduced on the
baseline before this work. All other enabled rules pass; custodian coverage is skipped by repository configuration.

The skills are installed as compiled playbook definitions for Calvary and the demo people. Their source artifacts are
in [skills PR 41](https://github.com/agentictrustlabs/skills/pull/41). Signed corpus publication and graph loading are separate.
Native writers remain under Seed's role assignment and sharing UX. Additional people/organizations need the corresponding
skill composed into their existing assignment and an adequate own-vault grant; this code does not silently grant access.
