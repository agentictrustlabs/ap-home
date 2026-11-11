# Spec 446 — Every app reaches its workspace agent the same way

**Status:** DRAFT, written 2026-11-11 for future work. Nothing here is built by this spec. The number is the next
free one seen in this repository and in Ring 0 `specs/` on that date (Ring 0's `INDEX.md` still says 445); confirm it
and record it there before work starts.
**The owner's words (2026-11-11):** "The A2A endpoint is our workspace agent, that has an owning custodian that goes
through a ceremony to set up access permissions to a backend MCP. The web app has a connected user who is associated
with a person agent that is given permission to interact with the A2A workspace agent. This is a pattern we use all
over the place in agentic primitives applications." And: "I want future A2A workspace agent endpoints to do the same
thing and need it to be as seamless as possible."
**Builds on:** ADR-0061 (`.workspace` names the WorkspaceAgent), spec 344 (the workspace is a context, never an
agent), spec 424 (a member reads through the governing org), spec 350 (mandates; out of scope here, see §8),
`docs/architecture/agent-rules/service-agent-signing.md` in Ring 0 (the key is a delegate, never the identity),
ap-federation spec 440 and its runbook `kms-tenant-for-an-estate.md` (one tenant per estate, one caller per Worker),
spec 441 (the estate is one shape; this spec does the same for apps).

---

## 1. The problem

The pattern exists and is live, but each app carries its own copy of it, some apps carry part of it, and nothing
checks which. A developer starting a new app reads three repositories to find the shape, and a reviewer cannot tell
from one place whether an app conforms. The ISL workbench was built three times in one day against three different
readings of it.

Setting up a conforming app also has one step that is not self-service: the endpoint's delegate key is created by an
operator on the AKCS node.

## 2. The pattern, stated once

Four parties and two grants.

| Party | What it is |
| --- | --- |
| Workspace agent | The app's A2A endpoint. A service Smart Agent (`<name>.workspace`, kind service, serviceRole workspace) with an owning custodian. It serves an Agent Card and `/a2a`. |
| Custodian | The person (or org steward) who created the workspace agent at their Home and holds it. |
| Backend MCP | A private tool-and-data server behind the endpoint, with no public route. It serves the workspace's data only to the workspace agent. |
| Person agent | The Smart Agent of a user connected in the web app. |

| Grant | From → to | How it is made | Where it is checked |
| --- | --- | --- | --- |
| G1, the service wire | Workspace agent → the endpoint's delegate key | The custodian's `service-agent-wire` ceremony at the Home. The Home calls the endpoint's `GET /admin/signer-address`, the custodian signs, the Home calls `POST /admin/service-wire`. Scoped to named skills, time-limited, revocable. | The endpoint presents it on every backend call. The backend verifies it per call. No wire means no data, and the endpoint says so. |
| G2, the person's access | Workspace agent (or its governing org) → the person agent | Stewardship at creation; membership by `workspace-member-invite` and `workspace-join`. | The endpoint verifies the caller's Home id_token, reads the caller's grants from `GET /connect/related-orgs`, and admits: members read, stewards act, high-consequence skills also need a `decision` case. |

The delegate key is custodied in AKCS: one signing key per endpoint, one caller for its Worker allowed
`key-public-key` and `key-sign` with `RAW_32_BYTE_DIGEST` only. The delegate address must differ from the custodian's.

Reference code: `engage/apps/gather27-a2a` (`src/admin.ts`, `src/service-wire.ts`, `src/workspace-roster.ts`) for G1;
`engage/apps/field-a2a` (`src/shared-records.ts`, `src/skills.ts`) and `engage/apps/field-web` (`src/intents.ts`,
`src/session.ts`) for G2; `engage/packages/engage-home` and `engage/packages/chain` for the shared helpers.

## 3. Where each app stands

From `apps/home/src/whitelabel/config.ts` at master on 2026-11-11 (templates allowed, `serviceAgentConfig.a2aBase`
present) and from the service code read that day. "Not checked" means the service code was not read; W1 fills it in.

| Client | `service-agent-wire` | Workspace templates | `a2aBase` | G1 at the service | G2 at the service |
| --- | --- | --- | --- | --- | --- |
| `gather-app` | yes | no | yes | yes (AKCS key, wire presented per read) | not checked |
| `field-app` | yes | create, invite, join | yes | not checked | yes (grants from related-orgs; `notSteward`; decision case) |
| `pokernight` | yes | create, invite, join | yes | not checked | not checked |
| `engage-app` | yes | no | yes | not checked | not checked |
| `skills-app` | yes | no | yes | yes (AKCS key `skills-a2a-delegate`) | owner check by stewardship; not a workspace |
| `isl-workbench` | yes | create, invite, join | yes | no: endpoint live on transition rules, no delegate key, no wire | built and tested locally, not switched on |
| `demo-corpus` | no | no | yes | content-signer ceremony (a different delegation shape) | n/a |
| `source-publishing`, `openbook-reader`, `seed-bible-reader`, `bible-explorer`, `ap-church`, `home-mcp` | no | no | no | `ask-as-me` only: the app asks the person's own agent; no workspace agent | n/a |
| translation and radar runtimes (skills repository, signing in as `skills-app`) | n/a | n/a | n/a | no: the runtime is not custodied outside its Worker; owner list in configuration | owner list, not grants |

Known departures to resolve, not yet decided:

- The publishing gateway holds its asking key as a Worker secret (`PUBLISHING_PRIVATE_KEY`), not in AKCS.
- Two apps share the `skills-app` client (the skills web app and the translation workbench), so one
  `serviceAgentConfig.a2aBase` cannot name both endpoints.
- The backend MCPs behind several endpoints are gated by a shared bearer between two Workers rather than by
  verifying G1.

## 4. What this spec delivers

**W1. The conformance check.** `scripts/app-shape.mts` and `pnpm check:app-shape`, in the manner of spec 441's
`estate-shape`. Input: one `apps/*.app.json` per app (client id, endpoint URL, whether it has a workspace agent, the
workspace agent's address, the delegate address, the AKCS key id, the skills on the wire). It checks, per app:

1. the Home client entry has the six templates and an `a2aBase` equal to the endpoint;
2. the endpoint answers `/.well-known/agent-card.json`, and `/admin/signer-address` returns the declared delegate;
3. the delegate address is not the custodian's, and its AKCS key is ACTIVE with a caller limited as in §2;
4. a current, unrevoked G1 exists on chain for the declared skills;
5. the endpoint refuses an anonymous call (401), a non-member read, and a member's act (`notSteward`);
6. the backend MCP has no public route.

First run records the drift table in §3 with every cell filled. It reports; it changes nothing.

**W2. One package for the endpoint.** Publish the door as a package (working name `@agenticprimitives/workspace-door`,
seeded from `engage` and from `isl-discovery-harness/packages/workspace-door`): id_token verification, the
`related-orgs` read and its cache, member and steward admission, tiers and the decision case, the two ceremony
routes, the wire store and its verification, the AKCS signer with the custodian check, Agent Card assembly, skill
dispatch, and the per-act record. An app supplies its skills and its MCP. Generic, no app vocabulary (ADR-0021).

**W3. The backend verifies G1.** A small verifier for MCP Workers (delegation hash, ERC-1271 on the workspace agent,
revocation, time window, the skill's method caveat, a short cache), so "the MCP serves only the workspace agent" is a
check and not a shared secret. The shared bearer stays as transport hardening only.

**W4. The delegate key becomes self-service.** Today: an operator runs `create-key` and `bind-caller` on the AKCS
node and mints a token (ap-federation runbook). Proposed, to be decided with ap-federation and faithkms:

- a named caller profile `workspace-endpoint` (as `estate-vault` and `estate-runtime` exist) fixing the allowlist; and
- one command, `pnpm new:workspace-endpoint <name> --estate <estate>`, that runs the operator step, sets the Worker's
  `AKCS_TOKEN` secret and key-id variable, and writes the `federation.yaml` record; or
- the same reached from the Home during the ceremony, if the operator boundary allows a Home-initiated key request
  for a Worker the custodian names. This option changes who may ask the KMS for a key and needs a threat review.

**W5. The template.** `create-app --template workspace-agent`: web app, endpoint on W2, MCP on W3, the Home client
entry as a patch, `apps/<name>.app.json`, and a README with the six setup steps.

**W6. Migration, one app at a time,** each a separate change with its own acceptance walk: ISL first (it is
mid-migration), then the apps W1 shows short of the shape. An app with no workspace agent is not migrated; it is
recorded as "ask-as-me only" in its `app.json`.

## 5. Setup after this spec

1. `create-app --template workspace-agent <name>`.
2. Merge the Home client entry.
3. `pnpm new:workspace-endpoint <name>` (the delegate key).
4. Deploy the endpoint, the MCP and the web app.
5. The custodian runs `workspace-create`, then `service-agent-wire`, from the app.
6. The steward invites members.
7. `pnpm check:app-shape <name>` is green.

## 6. Acceptance

- `pnpm check:app-shape` runs in CI for every app with an `app.json`, and nightly against the live estate.
- For each migrated app: with G1 revoked, the endpoint serves no workspace data and names the reason; restoring it
  by the ceremony restores service with no deploy.
- For each migrated app: removing a member at the Home refuses that person's next call after the cache expires.
- A new workspace agent stood up from the template passes the check with no hand edits to Home, KMS or chain
  configuration beyond the listed steps.

## 7. Risks and open questions

- **`related-orgs` on every call.** One Home request per caller per cache window. Not measured under load.
- **Spec 424 is draft.** Its scope list for the member read needs confirming before G2 is relied on everywhere.
- **Shared clients.** Whether the translation workbench gets its own client or `serviceAgentConfig` becomes a list.
- **Publishing's key.** Whether the asking key moves to AKCS under this spec or under a publishing spec.
- **W4's third option.** A Home-initiated key request widens the KMS's callers; it may be refused on review.
- **Wire lifetime.** 90 days in the consent text. The check should warn before expiry, and renewal should be one
  click for the custodian.

## 8. Out of scope

- The signed-mandate flow of spec 350 (`authority_required`, a person signs for one ask). It applies when an agent
  runs a plan for a person and reaches a step nobody authorized; it is orthogonal to G1 and G2.
- Apps that only ask the person's own agent (`ask-as-me`) and have no workspace agent.
- Cross-town presentation of these grants (ap-federation spec 439).
