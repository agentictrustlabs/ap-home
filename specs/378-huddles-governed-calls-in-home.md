# Spec 378 — Huddles: a governed call inside a Home context

**Status:** W1 ✅ shipped + live on faithnet 2026-09-08 (§7; the control plane gated by `scripts/verify-huddle.mts`; the browser call itself is a manual check until W3's Playwright twin); W2–W4 open · **Kind:** Product feature (Home) + one new Ring-0 package + a serving-plane object + a provider adapter
**Grounds:** [234](234-white-label-trust-site.md) (Home renders the control plane) · [322](322-interactions-substrate.md)/ADR-0055 (DO-local state is serving-plane; the vault is the record) · [350](350-authority-aware-agent-harness.md)/[353](353-app-scoped-ask.md) (a screen action and an Ask action are one capability; scope is honesty, the mandate is authority) · [366](366-subject-routed-ask.md) (an act about an organization is judged by that organization's standing) · [372](372-standard-a2a-surface-conformance-and-outsiders.md) (an outsider's act parks for a steward) · ADR-0041 (a message is never authority) · ADR-0044 (first-party web expresses intents to the A2A host; never a second control plane) · ADR-0021 (provider integration lives in apps and adapters, never in packages)
**Provider:** Cloudflare RealtimeKit — `POST accounts/{account}/realtime/kit/{app}/meetings`, `POST …/meetings/{id}/participants` → `authToken`, `POST …/meetings/{id}/active-session/kick-all`, `PATCH …/meetings/{id} { status: "INACTIVE" }`, `DELETE …/meetings/{id}/participants/{pid}`; webhooks signed `rtk-signature` (RSA-SHA256 over the raw body, public key at `https://api.realtime.cloudflare.com/.well-known/webhooks.json`); browser `@cloudflare/realtimekit-react` (`useRealtimeKitClient` → `initMeeting({ authToken })`, `meeting.join()/leave()`, `meeting.self.enableAudio()/disableAudio()/enableScreenShare()/disableScreenShare()`, `meeting.participants.joined`).

## 0. The boundary, stated once

**Agentic Primitives decides who may start, join, invite, record or end a huddle. Cloudflare carries the
audio, video and screen. Home presents the experience.** RealtimeKit is built for exactly that split — the
application owns users and workflows, the provider owns sessions and media — so the engineering goes
into the governed control path and the Home experience, never into a conferencing engine.

Three consequences follow and every wave below is checked against them:

1. **No media through the control plane.** Audio and screen frames go browser ⇄ RealtimeKit. A2A, the
   harness, the huddle object and the vault never see a frame.
2. **A provider credential is never authority and never evidence.** The participant `authToken` is
   returned ONCE to the participating browser over an authenticated, non-model path, held in memory,
   and appears in no conversation, URL, receipt, audit row or log. Ask returns a join CARD; Home redeems it.
3. **The huddle is a collaboration activity of the agent it belongs to, not a new agent.** A huddle
   belongs to a person's conversation, an organization, a team or a workspace; the Cloudflare meeting id
   is a provider binding on that activity. No Smart Agent is chartered for a call.

## 1. Product — audio-first, inside a context, in a dock

A huddle is started FROM something that already exists in Home: a direct conversation, an organization,
a team, a workspace. Authorized members see an active-huddle indicator and join; the call lives in a
small dock that survives navigation. First release: audio, avatars, active-speaker, microphone and
device controls, leave and end, invitations, screen sharing. Camera video is secondary (an audio/video
preset with cameras off, not the audio-only preset — the Voice preset makes video APIs non-functional,
and cost follows the PRESET, not whether a camera was used). Recording and any AI listening are off.

**Participation identity is frozen for the life of the join.** Switching Home's selected agent must not
turn "Richard in the team huddle" into "Richard representing another organization in the same huddle":
the dock shows the human participant and, when one applies, the principal represented, and both stay
until the person leaves and joins again.

**Local device controls are local.** Choosing a microphone, muting, picking a screen are the browser's
own client actions — never a remote business transaction, never something Ask performs silently (it may
OPEN the control). Leave stops local capture at once, even while the server-side leave is retrying.

## 2. Who decides — five things kept apart

| | |
| --- | --- |
| **Actor** | the authenticated person or service (the Home session, verified as every route verifies it) |
| **Represented agent** | the principal on whose behalf they take part — themselves, or an organization they stand in |
| **Scope** | the conversation / organization / team / workspace the huddle belongs to |
| **Executing service** | the software agent performing the operation (the A2A host) |
| **Device session** | the browser connection that receives the media credential |

A client-supplied `isHost`, a preset name or a selected-agent id is never evidence of permission. The
scope is resolved from the intent, the caller's standing at the scope is DERIVED (`deriveStanding` — the
same rule every act about an organization uses, spec 366), and the operation's requirement is judged
against it:

| Operation | Requires |
| --- | --- |
| `huddles.start` | for an organization / team / workspace scope: member or steward of it; for a conversation scope: a party to it |
| `huddles.join` | current admission: member/steward of the scope, OR an unexpired invitation on the run — re-evaluated at join time, never cached from an earlier "was allowed" |
| `huddles.invite` | a joined participant; inviting an OUTSIDER (no standing at the scope) is an act that parks for a steward's approval (372 N1) |
| `huddles.leave` | the participant themselves |
| `huddles.end` | the starter, or a steward of the scope |
| `huddles.removeParticipant` | a steward of the scope, or the starter |
| `huddles.list` / `huddles.get` | standing at the scope; a stranger is told nothing exists |

Permission to listen, publish audio, share a screen, invite outsiders, record and admit an AI participant
are SEPARATE facts and map to separate provider preset powers. The presets Home selects server-side are
no broader than what the authority intends; a button hidden in the dock is not enforcement, and a
provider-side power the mandate did not grant is a bypass.

## 3. What is new, and where

| Piece | Where | Doctrine |
| --- | --- | --- |
| **`@agenticprimitives/collaboration`** — `HuddleScopeV1`, `HuddleRunV1`, `HuddleParticipantV1`, `HuddleEventV1`, the lifecycle reducer (`creating → active → ending → ended`), admission rules as pure functions, and the **`MediaProviderPort`** (`createMeeting`, `addParticipant`, `removeParticipant`, `endSession`, `deactivateMeeting`, `verifyWebhook`) | new package, Ring 0, no provider SDK, no React, no Worker types | ADR-0021 / ADR-0037: the portable core; providers and UI are adapters |
| **`HuddleRoomDO`** — one object per **scope key** (`<scopeKind>:<principal>:<scopeId>`), holding the current run and its provider binding, idempotency records, admission references, empty-room and max-duration deadlines under its alarm | `apps/agent-runtime/src/huddle-room-do.ts` | ADR-0055: serving-plane state — if wiped, a huddle is a rebuild (its record is the messaging thread and the audit), never a bereavement |
| **RealtimeKit adapter** — the `MediaProviderPort` over the management API, secrets from env; a listed-but-keyless deployment is a thrown configuration error, never a fallback (ADR-0013) | `apps/agent-runtime/src/realtimekit.ts` | provider integration lives in the app |
| **Routes** — `POST /huddles/<op>` (Home session + CSRF, standing derived here) and `POST /huddles/webhook` (signature verified against the published key; events accepted durably, then reconciled) | `apps/agent-runtime/src/index.ts` | one execution path for Home and, in W2, Ask |
| **Home** — `HuddleProvider` (owns the browser meeting instance), `HuddleDock` (persistent, above routed content), `HuddlePanel` (participants, mic, screen, leave/end), `JoinHuddleCard` (an invitation in a thread, an active huddle on a team, an Ask result) | `apps/home` | Home presents |

**Two starts at once resolve to one huddle.** The scope's object serialises `start`: the second caller
gets the run the first created. **A new provider meeting per run**: the scope is stable, the meeting is
not reused across runs, and a credential issued for an ended run opens nothing. **State before side
effect**: the object records `creating` (with its idempotency key) BEFORE calling the provider, and a
run whose provider call did not come back is reconciled or cleaned up, never assumed.

## 4. Live revocation is the acceptance test

Stopping new tokens is not removing someone who is listening. The adapter has four separate
operations and `huddles.end` uses three of them in order: mark the run `ending` (no further admission),
`PATCH status INACTIVE` (no future joins), `kick-all` (drop live media), then reconcile until the provider
reports the session closed; the operation is not "done" when the first call returns. `removeParticipant`
drops the participant's live media AND deletes their provider participant so a fresh token is refused;
the two are tested separately because the provider documents them separately. Multiple devices per
participant are a documented provider behaviour; the roster, revocation and "already in another tab"
account for it.

## 5. Invitations are messages; admissions are decisions

An invitation is an existing messaging delivery — a direct message carrying a huddle reference and a
Join action, rendered as the `JoinHuddleCard`. Receiving it grants nothing durable: when the recipient
joins, admission is re-evaluated against current policy (the invitation is one of the admissible
grounds, bounded by expiry). This is also the door for outside guests — invitation, approval where
required, bounded admission — and it keeps RealtimeKit's own chat OUT of Home: the conversation stays
in messaging, with messaging's permissions and retention.

## 6. Agents, in two stages

An agent that COORDINATES a huddle — starts it, invites, checks standing, surfaces follow-ups — is the
first implementation's Ask parity (W2): the same capability definitions drive the dock buttons and the
Ask. An agent that HEARS or SPEAKS is a separate media integration with explicit participant awareness
(W4): an A2A endpoint is not an audio participant. When transcription arrives it is consent → authorized
transcription → proposed summary → Home review → the existing messaging / interactions / governed
execution. Speech in a huddle is evidence, never a mandate: "we should pay that invoice" performs nothing.

## 7. Waves + gates

| Wave | Delivers | Gate |
| --- | --- | --- |
| **W1 — the governed call** ✅ 2026-09-08 | `@agenticprimitives/collaboration` (contracts, reducer, admission, port; 7 unit tests); `HuddleRoomDO` (one per scope key; serialised start; state before side effect; `ending → deactivate → kick → ended`; empty-room and max-duration alarm); the RealtimeKit adapter (management API; `kick-all` with no live session reads as nothing to kick; RSA-verified webhooks); routes `POST /huddles/{start,join,get,leave,end,invite,removeParticipant}` with standing derived at the scope, `POST /huddles/webhook`; **the `topic` scope** — a huddle inside a team's discussion topic, its own room per topic, the organization posting one line into the topic on start and on end; Home `HuddleProvider` + `HuddleDock` (persistent, above routed content; mic, screen, leave, end; the represented principal shown) + `HuddleAffordance` in every topic header; secrets set on faithnet (app `faithnet-huddle`, presets `group_call_host` / `group_call_participant`) | unit: the reducer and admission (7), the adapter and webhook (6). **Live** `scripts/verify-huddle.mts`: alice starts at Missio Nexus and is joined; two starts at once → one run; bob (member) joins; david (no link) refused and told nothing exists; bob cannot end; alice ends → deactivated ✓ kicked ✓ ended; a topic huddle in `# default` is a separate run, seen by bob, hidden from david, and the topic carries the organization's two lines |
| **W2 — native to Home + Ask parity** | invitations in the thread; active-huddle projection on organizations and teams; device selection; reconnect; the `huddles.*` capabilities as SKILL.md contracts so the dock's buttons and the Ask are one definition (spec 361) | "start a huddle for this team" / "invite Susan" / "is anyone in a huddle?" through the Ask; the join card from an Ask result redeems the token through the authenticated path only |
| **W3 — hardening** | cross-tenant access, concurrent starts, old-token reuse, live removal, multiple tabs, duplicate callbacks, failed provider calls, microphone persistence after leave; max duration and usage limits | each as a named twin in the live gate |
| **W4 — consented transcripts** | RealtimeKit transcription behind explicit consent; summaries and action items proposed into messaging / interactions; retention under the vault's policy | speech never performs an act |

## 8. Boundaries (the drift to refuse)

- **No second identity.** The custodian's Home session is the login; there is no conferencing user.
- **No second conversation.** Provider chat is not enabled; the thread is messaging's.
- **No token in the model's reach.** An Ask result is a card with a session-bound handle; the browser
  redeems it. A token in a prompt, a URL or a receipt is a defect, not a convenience.
- **No verdict cache.** The object stores authorization REFERENCES and the policy revision, never "this
  person was once allowed".
- **No preset wider than the mandate.** Recording, removing others and admitting an AI participant are
  provider powers that stay off the participant preset until the corresponding authority is judged.
- **Cost is a preset.** Audio/video-capable participants are billed as such with cameras off; the
  audio-only preset is a deliberate voice-only mode, chosen per scope policy, not per whim.

## Reference: patterns to port

- smart-agent has no call surface. The nearest field analogue is Slack's huddle (a context-bound,
  dockable, audio-first call): we take its SHAPE and diverge on AUTHORITY — Slack's admission is a
  workspace ACL; ours is standing derived from records the organization itself keeps, judged at join time,
  with revocation that reaches the live media, not only the next token.
