# Spec 397 — Home MCP: Claude.ai's entrance to a person's own agent, and through it to the agentic enterprise

**Status:** Draft 1 — spec analysis, 2026-09-10 · **Kind:** a new app (`apps/home-mcp`, a Cloudflare Worker: a standards-conformant remote MCP server that is ALSO an OAuth 2.1 authorization server for MCP clients and a registered relying app of the Home) + one new principal scheme on the a2a surface (`App-Delegation`) + registry upgrades (`demo-discovery-a2a`) + two harness capabilities with contracts (`~/skills`) · **Extends:** [spec 387](387-ap-gateway-mcp-facade-of-a2a.md) (option 1 — the gateway as its own agent; kept, for hosts that are nobody) · **Grounds:** [spec 230](230-agentic-connect-oidc-provider.md) (the Home as OIDC provider: `/authorize` mints an `id_token` AND a caveated delegation `agent → delegate` under a registry-gated template), [spec 295](295-relying-connect-client.md) (a relying app never runs a credential ceremony of its own), [spec 341](341-home-a2a-only-control-plane.md) (per-app grants, revocable by the app's `client_id`), [spec 353](353-app-scoped-ask.md) (`AskScopeV1`: the app says where the person stands, never what they may do), [spec 366](366-subject-routed-ask.md) (the subject-routed ask: a person's agent asks another agent over A2A under the person's standing), [spec 372 §S3c/S4](372-standard-a2a-surface-conformance-and-outsiders.md) (a second principal scheme is never a fallback; an assertion is spent once), [spec 379](379-external-a2a-agents-as-steps.md) (an outside agent may answer, never act), [spec 349](349-ard-discovery-conformance.md) (ARD conformance, and its blocking gap), [spec 336](336-intent-engagement-profile.md) (probe → offer → mandate), [ADR-0041](../docs/architecture/decisions/0041-web3-authority-not-oauth-on-a2a-to-mcp.md) (OAuth is the ingress envelope; Web3 is the authority), [ADR-0057](../docs/architecture/decisions/0057-a2a-over-https-admission-mtls-optional.md) (MCP is private behind an admitted runtime — the deviation this spec declares in §8), ADR-0013, ADR-0025, ADR-0040

## 0. The two entrances, and why the second one is the product

Option 1 shipped as spec 387: `Claude.ai → AP Gateway MCP → registry → the ministry's A2A agent`. The gateway is an
agent of the estate (`gateway.svc`) that speaks A2A as itself, spends no authority, holds no session of anyone,
and offers four stable tools. It is right for a host that is **nobody** — an anonymous assistant asking a public
registry for public agents. It is deliberately powerless: every act it reaches suspends for the target's stewards,
and it cannot know who is asking.

Option 2 is the one this spec designs: `Claude.ai → Home MCP → Alice's Person Agent → (Discovery Agent → Registry) | (the ministry's Service Agent → its private MCP)`. The host is **somebody** — Alice, signed in to her Home
through Claude's OAuth flow — and what Claude reaches is her own agent, with her standing, her memory, her
playbook, her private tier, and her delegated access to every organization she is a member or steward of. The
registry is reached *through her agent* (the Discovery Agent is one more agent her agent asks), and a ministry is
engaged *by her agent* under her standing (spec 366's routed ask), so a receipt names her, a mandate is hers to
sign, and the provenance lands in her vault. Claude keeps everything Claude is — reasoning, the conversation,
its own tools — and gains what no other host has: an intent-driven, authority-bound reach into an enterprise of
agents that answers to the person, not to the host.

```
Claude.ai
   │  MCP (Streamable HTTP) + OAuth 2.1 (PKCE, RFC 9728 / 8414 / 7591 / 8707)
   ▼
Home MCP  (apps/home-mcp — resource server + authorization server; a registered relying app of the Home)
   │  who: Alice (the Home's OIDC id_token)   how: her delegation → the Home MCP's delegate SA, caveated to `harness.ask`
   ▼
Alice's Person Agent  (demo-a2a `/harness/ask` under the App-Delegation scheme — standing, memory, playbook, private tier)
   ├── A2A → discovery.registry (the Discovery Agent) → ARD search → handles (spec 349/386)
   └── A2A → ligonier.svc (subject-routed ask under Alice's standing, spec 366) → its catalog MCP (spec 387 W2)
```

**The claim.** Every other assistant integration hands the assistant an OAuth scope and calls it access. Here the
assistant is a *client of the person*, the person's agent is the *principal*, and what the assistant may do is
an on-chain delegation the person signed, can read on her Home, and can revoke in one act — while the acts that
matter still wait for her signature, exactly as they do when she types them herself.

## 1. The rule, stated once

**Claude is Alice's client; the Home MCP is Alice's ingress; her agent is the principal; authority never leaves
the chain.** OAuth (as the MCP specification requires it) authenticates *which client of which person* is
calling, and nothing more — a bearer at the Home MCP is a client credential, never a grant. What the Home MCP
carries downstream is not that bearer (the MCP rule "never pass an inbound token through" is ADR-0041's rule
too) but **Alice's own delegation to the Home MCP's delegate agent**, minted by the Home at sign-in under a
registry-gated template that pins `harness.ask` and nothing else, bounded in time, revocable by Alice under
the app's `client_id` (spec 341). Alice's agent runs the ask *as Alice*, derives her standing itself, reads her
tier itself, and suspends on any consequential act until Alice signs the mandate — at her Home, where her
credential is, never in Claude. The scope the Home MCP declares to the MCP host (`ask`, `discover`, `engage`) is
honesty about what the surface offers (spec 353), and no verifier reads it.

## 2. The standards surface (MCP, exactly; OAuth 2.1, exactly)

The Home MCP is **not** constrained by ADR-0057's "MCP is private" rule (§8 declares the deviation): it is a
public, conformant remote MCP server, because that is the only door Claude.ai has. It is constrained by the
MCP specification, fully:

| Requirement (MCP spec, 2025-06-18 and later) | Home MCP |
| --- | --- |
| Transport: Streamable HTTP; `POST /mcp` JSON-RPC, optional SSE stream, `GET /mcp` for server-initiated messages, `Mcp-Session-Id`, `MCP-Protocol-Version` header | `@agenticprimitives/mcp-protocol` (versions `2025-11-25`, `2026-07-28`); a **session per (person, client)** held in a Durable Object keyed by the OAuth subject — the session id is opaque and never carries identity |
| Authorization: the server is an OAuth 2.1 **resource server**; `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"` (RFC 9728) | served; `resource` = the MCP endpoint URL; `authorization_servers` = the Home MCP's own AS; `scopes_supported` = `ask discover engage` |
| AS metadata (RFC 8414) at `/.well-known/oauth-authorization-server`; PKCE S256 **required**; `code_challenge_methods_supported`; **resource indicators (RFC 8707)** — the client sends `resource=<MCP URL>`, the token's `aud` is exactly that | the Home MCP is its own AS (§3): `authorize`, `token`, `register`, `revoke`; tokens are opaque references to a DO row `{ sub, client_id, scopes, resource, exp }`, never JWTs a third party could replay elsewhere |
| Dynamic client registration (RFC 7591) — Claude.ai registers itself | `POST /register` issues a `client_id` (+ optional secret) bound to the redirect URIs given; registrations are unprivileged (the same doctrine as the Home's self-service OIDC registry, spec 230 §6): they decide who may *ask*, never what is granted |
| Token audience/passthrough | the bearer is validated for THIS resource only; **nothing downstream ever sees it** (what goes downstream is the person's delegation, §4) |
| Tools: `tools/list` with `inputSchema`, `outputSchema` (structured results), annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) | the fixed surface of §5; **never per-agent dynamic tools** (387's rule holds — stability of the connection is the point) |
| Long operations: progress notifications, cancellation, `tasks` where the host supports them | `invoke` returns the A2A task state and a `taskId`; progress notifications are emitted from the run's progress lines (370 P2) while the host holds the stream; `get_task`/`continue_task` for hosts that do not |
| Elicitation (server → client request for input) | used for a **data** prompt only ("which David?", "how much?") when the host advertises the capability; an **authority** prompt is never elicited — it is a link to the Home (§6) |
| Resources / prompts | `resources`: the person's recent runs and their `hasProvenance` links (read-only, under the same bearer); `prompts`: none in W1 |

## 3. Identity: how the Home MCP knows it is Alice, and what it holds for her

The Home MCP is **two OAuth parties at once**, and the two never share a token:

1. **Toward Claude — an authorization server.** `GET /authorize` (PKCE, `resource`, `state`) starts a flow the Home
   MCP does not complete itself: it redirects to **the Home's OIDC provider** (spec 230 `/authorize`) as a
   registered relying app (`client_id = home-mcp`, curated in `oidc-clients.ts`, redirect = the Home MCP's callback,
   `delegation_template = ask-as-me`, `delegate = <the Home MCP's delegate SA>`). The Home runs Alice's credential
   ceremony — passkey, Google-KMS, whatever custodies her — because a relying app never runs one (spec 295).
2. **From the Home — a relying app.** The callback exchanges the code at the Home's `/token` (spec 230 §4.3) and
   receives `id_token` (`sub` = Alice's CAIP-10, `aud = home-mcp`) **and** the agent-native `delegation`: a
   `DelegationWire` `alice → home-mcp delegate`, caveated by the `ask-as-me` template (§4). The Home MCP stores the
   wire in a **per-person DO** under the subject, encrypted with a Worker-held KEK, with the `id_token`'s claims;
   then mints ITS OWN authorization code for Claude, which Claude exchanges at the Home MCP's `/token` for an
   opaque access token (`aud` = the MCP URL, scopes as consented, refresh token rotating).

What the Home MCP holds per person: the delegation wire (Alice's, to the Home MCP's delegate), the subject, the
consented scopes, the client registrations. What it never holds: Alice's credential, her Home session, a key that
custodies anything of hers. What Alice sees at her Home: **one connected app, `Claude (Home MCP)`, with the
delegation it holds and a Revoke** — the same screen every relying app appears on (spec 341), and revocation is
on-chain, so it takes effect at Alice's agent's gate, not at the Home MCP's discretion.

**The Home MCP's own identity.** A service agent of the estate (`home-mcp.svc`, chartered under the operator's
organization like `gateway.svc`, custodied by a key only the Worker holds). It is the `delegate` of every
`ask-as-me` wire and the signer of every `App-Delegation` assertion (§4). Revoking that agent revokes every
Claude connection in the estate at once — the operator's kill switch is the same primitive as Alice's.

## 4. The `App-Delegation` scheme: how Alice's agent runs an ask as Alice for a client of hers

A **third principal scheme** on demo-a2a's `/harness/ask` (spec 372 S3c's rule: never a fallback; each scheme is
verified on its own terms):

| Scheme | Who is asking | Proof |
| --- | --- | --- |
| `Bearer` (Home session) | the person, from their Home | the broker's signed session (`verifyHomeSession`) |
| `A2A-Session` (session wire) | an agent, as itself | the agent's wire to its runtime key + a per-request assertion (372 S3c) |
| **`App-Delegation`** (this spec) | **the person, through a client they authorized** | **the person's delegation to the app's delegate agent (the 230 wire) + a per-request assertion signed by the app's key over `{ delegator, delegate, method, bodyHash, issuedAt, audience }`** |

The surface verifies, per request: the wire's delegator is the person the request claims to act for; the wire's
delegate is the asserting agent; the caveats are exactly the `ask-as-me` template (pins `harness.ask`; a
`timestamp` window; the digest-binding caveat absent — an ask is not an intent); the wire ERC-1271-verifies
against the delegator; it is **unrevoked on chain**; the assertion's signature recovers to the delegate's key; the
assertion is **spent once** on the person's own object (372's `assertion-claim`). Then the run: `person = the
delegator`, `session = none`, `surface = { app: 'home-mcp', capabilities?, ceremonies: ['data'] }` (spec 353 —
the app says the ceremonies it can render: data, never signature), and everything after is the ordinary run —
standing derived from her vault and the chain, memory read from her records, the playbook hers, every act
suspending at `authority_required` for HER mandate.

**What the template does NOT do.** `ask-as-me` grants no capability: `harness.ask` is the act of *asking*, and
the harness's own gates decide every step. A payment asked through Claude waits for Alice's signature exactly as
a payment typed into her Home does. The only thing the wire buys is the right to *put the question to her agent as
her* — which is the whole of what an assistant should have.

**Runs made through an app are labelled.** The receipt's `binding.actor` carries `via: { app: 'home-mcp', client }`
(the OAuth `client_id` Claude registered under — a name, never a token), so the timeline and the provenance
graph say *asked through Claude*, and the 385/394 memories are written under the same room rules as any ask
at her own agent (the room is her agent; the app is not a room).

## 5. The tool surface (fixed; the enterprise lives behind her agent)

| Tool | Scope | What it does at Alice's agent | Returns |
| --- | --- | --- | --- |
| `ask { message, addressee?, model? }` | `ask` | **the Ask** — `/harness/ask` as Alice at her own agent (or at an organization she stands in, `addressee` = its name); the planner plans from her playbook; reads answer, acts suspend | the reply (`answer` / `done` / `prompt` / `authority_required` / `refused`), `runRef`, `hasProvenance`, and for a prompt the fields (elicited when the host can) |
| `discover_agents { intent, capability?, language?, region?, limit? }` | `discover` | her agent asks the **Discovery Agent** (an A2A skill on `discovery.registry`, spec 349) — an ARD search planned deterministically from the intent; results are `service` cards + opaque **handles** (387's handle, minted by the Discovery Agent, never an endpoint) | services with public facts, `handle`, `referral { registry, receipt? }`; the search is a run of hers (provenance) |
| `inspect_agent { handle }` | `discover` | the card re-fetched through the handle; public facts; whether the served card still matches the pin | the card's public facts |
| `engage { handle, message, task? }` | `engage` | **the subject-routed ask** (spec 366): her agent sends ONE A2A message to the handle's agent under her standing (routed step, `observedVia: network`), the target runs it under ITS playbook and gates; an outside agent's answer is an observation, never authority (spec 379) | the target's reply, `taskId`, artifacts (`results`, `trace`), `hasProvenance` of HER run (the routed hop is a bundle `wasInformedBy` hers, spec 389) |
| `get_task { handle, taskId }` / `continue_task { handle, taskId, input }` | `engage` | A2A `GetTask` at the target; a prompted task continued from the host on the same checkpoint (387 W3) | the task, translated |
| `my_runs { limit? }` / `run { runRef }` | `ask` | her recent runs on her agent and one run's record view (`/harness/records`), the timeline's facts, `hasProvenance` (+ `public`) | records without mandates |
| `grant { runRef }` | `ask` | for a run parked `authority_required`: **the link to her Home where she signs** (`https://<handle>.<home>/you?run=<runRef>`), the requirement in words, and nothing else | a URL and a sentence — never a signature ceremony inside Claude |
| `resume { runRef }` | `ask` | after she granted at her Home: the run resumed for this client (the same rule as 387's `continue_task` — parked for THIS caller) | the reply |

Never offered: a per-ministry tool, a raw vault read, a mandate mint, a payment tool. What Alice's agent can do
is what her playbook says (`person-steward` + the two capabilities below); Claude sees the door, not the rooms.

## 6. Authority through a host that cannot sign

The one thing Claude cannot do is custody Alice's credential, and the design does not pretend otherwise. An act
reaches `authority_required` at her agent; the tool result says so, names the requirement in words (the 353 S4
`describeRequirement` sentence), and `grant { runRef }` gives the link to her Home. She signs there — the mandate
is minted by her Home's `mintApprovedMandate`, the digest-bound caveat naming this run's intent — and the run is
parked on her agent's object exactly as a run she abandoned mid-flyout would be. Claude calls `resume { runRef }`
(or she says "done" and Claude does) and the run finishes under the mandate she signed. **The host is never a
signer, never a custodian, never in the loop of authority** — only in the loop of the conversation.

Two refinements the substrate already makes cheap: **standing instructions and confirmation memory** (394/385)
make the second time through a question shorter; **spec 385's confirmation** written from a Claude-elicited
answer is written under the same trusted-event rule (the resume that supplied the choice), so Claude's readings
of "she means alice3" never write memory — only her supplied answer does.

## 7. What changes where

### 7.1 `apps/home-mcp` (new Worker; Ring-0 packages + app wiring)
- MCP server on `mcp-protocol` (initialize / tools / resources / elicitation when offered / progress), a
  per-(person, client) session DO.
- OAuth 2.1 AS: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/authorize`
  (→ the Home's `/authorize` with `client_id=home-mcp`, `delegation_template=ask-as-me`, `delegate=<home-mcp.svc>`),
  `/callback`, `/token` (PKCE, `resource`, refresh rotation), `/register` (RFC 7591), `/revoke`. Opaque tokens in a
  DO; `mcp-oauth`'s metadata + 401 builders reused; nothing from `demo-mcp`'s dev-only mint.
- Per-person DO: the `ask-as-me` wire (KEK-encrypted), subject, consent; the A2A client (`@agenticprimitives/a2a`)
  used only to reach **Alice's own agent** (`/harness/ask` under `App-Delegation`) — the Home MCP never talks to a
  ministry; her agent does.
- Identity: `home-mcp.svc` chartered by the operator's Ask (`scripts/charter-home-mcp.mts`, the 387 pattern);
  `HOME_MCP_PRIVATE_KEY` secret; `mint-…` not needed — the person's wire is minted by the Home at sign-in.
- White-label: the Home's origin, the operator organization, the connector name — in `whitelabel.ts` (ADR-0021).

### 7.2 `apps/demo-sso-next` (the Home)
- Curated client `home-mcp` in `oidc-clients.ts`; the `ask-as-me` delegation template in the registry's template
  table (pins `harness.ask`, 30-day window default, no digest binding, no value caveat) — registry-gated (SEC-001).
- The connected-apps screen shows `Claude (Home MCP)` with its wire and **Revoke** (spec 341 — exists; the row is new).
- A deep link `/you?run=<runRef>` that opens the Ask flyout on that parked run (the flyout already lists
  unfinished runs; the link selects one).

### 7.3 `apps/demo-a2a` (Alice's agent and the estate's A2A surface)
- The `App-Delegation` principal scheme on `/harness/ask`, `/harness/records`, `/harness/runs` (`a2a/standard/caller.ts`
  gains `verifyAppDelegation`; the assertion-claim ledger reused; `AskScopeV1.app` carried; `binding.actor.via`).
- Two harness capabilities, contract-driven (one capability model — the rule): **`discovery.agents.find`**
  (an A2A skill call to `discovery.registry`'s Discovery Agent — a routed read; the registry never invokes) and
  **`engagement.agent.invoke`** (the subject-routed ask to a handle's agent — a routed step under standing; today's
  366 machinery, with the handle verified through the card the way 387 does). Both `establishes: 'lookup'` /
  `'submission'`; neither is authority.
- `hasProvenance` on every reply already; the routed hop's bundle `wasInformedBy` hers (389 W3) — nothing new.

### 7.4 `apps/demo-discovery-a2a` (the registry, as an agent)
- **The Discovery Agent skill** on `discovery.registry`'s A2A card: `discover` (intent + filters → ARD search →
  services + **handles** minted by the registry agent under its key, 387's shape) and `inspect`. The registry
  finds and points; it never invokes — the handle is the registry saying *this is who I meant*.
- **349 §1b closed**: capability ids in the KB (`parseCapabilityIds` admits dotted ids; the projector's missing
  triple found with the probe §1b names; the indexer's `TLDS` walk covers typed names). Without it `capability`
  filters match nothing and every `discover_agents` is text-only.
- **349 §2 relevance**: intent text → capability-id resolution before the structured matcher, deterministic
  (a curated synonym table per context in `~/skills`'s ontology — `gc:` topics → capability ids), with the lexical
  cutoff published; `score` stays relevance, never trust (346 §8.3).
- `referral.receipt` where an entry carries an attestation; `ap:` trust evidence rides beside, never blended.

### 7.5 `~/skills`
- Contracts `person-discovery-find` (`discovery.agents.find`) and `person-engagement-invoke`
  (`engagement.agent.invoke`), attached to `person-steward` (+ `-runtime`) and `org-steward`: the Ask can say
  "find me a ministry with a study on justification and ask them for a six-week plan" and the playbook compiles
  it into find → invoke, the same two steps Claude's tools call directly.
- The `discovery-agent` archetype for `discovery.registry` (its `discover`/`inspect` skills as contracts, the
  handle rule in doctrine: *a handle names, an endpoint is never in a result*).
- The `content-catalog` archetype (387 W2) stays the ministry side.

## 8. The ADR-0057 deviation, declared

ADR-0057 says MCP is a private capability interface behind an admitted runtime, absent from every card, and a
public MCP ingress that relays is non-conformant. The Home MCP is a public MCP ingress. It is admitted **as a
relying app of the person** (spec 230/295/341), not as a peer of the estate: it appears on no agent card, it
relays nothing (what it forwards is the person's own delegation and the person's own words to the person's own
agent), and every hop past her agent is A2A under her standing. The amendment to record: *a public MCP server
that is a registered relying app of a person, holding only that person's `ask-as-me` delegation and reaching
only that person's agent, is a Home surface — the same class as the Home's own `/connect/*` routes — and is
conformant to this ADR.* The gateway (387) remains the entrance for a host that is nobody.

## 9. Boundaries (the drift to refuse)

- **The bearer never leaves the Home MCP.** Not to her agent, not to a ministry, not in a log. The wire is what
  travels, and it is hers.
- **`ask-as-me` never widens.** A second template ("act-as-me") is the failure this spec exists to prevent; any
  act needs her signature at her Home.
- **No per-ministry tools, no vault tools, no dynamic surface.** The door is stable; the rooms are her agent's.
- **The registry is an agent she asks, never a service the Home MCP calls.** Discovery is a run of hers with
  provenance; the Home MCP has no registry client.
- **The Home MCP is not the Discovery MCP, and the Discovery MCP is not a relay** (386 §4 stands).
- **One mechanism.** An `App-Delegation` that fails to verify is refused in the surface's words; nothing falls
  back to a session, a gateway wire, or an anonymous ask.
- **ADR-0025 / ADR-0040 unchanged.** Her private tier is read by her agent under her grant; nothing of hers
  reaches the registry; the registry holds only chain-derivable facts.

## 10. Waves + gates

| Wave | Delivers | Gate |
| --- | --- | --- |
| **W1 — the door** | `apps/home-mcp` with the full OAuth 2.1 AS + RS surface and MCP transport; `home-mcp` curated client + `ask-as-me` template at the Home; `home-mcp.svc` chartered; the `App-Delegation` scheme on `/harness/ask`; tools `ask`, `my_runs`, `run`, `grant`, `resume` | **MCP/OAuth conformance** (unit, over the metadata and the flows: PRM, AS metadata, DCR, PKCE S256 required, `resource` required and audience-checked, refresh rotation, 401 shape); **live** `scripts/verify-home-mcp.mts`: registers a client (7591), completes the flow as alice (the demo-signin persona path drives the Home's authorize), gets a token, `initialize` → `tools/list` → `ask` "who is in Missio Nexus?" answers from her agent with her standing; the twins: the bearer presented at her agent directly is refused; the wire revoked at her Home → the next `ask` is refused at her agent's gate in its words; a second client's token cannot resume her run |
| **W2 — the enterprise** | `discovery.agents.find` + `engagement.agent.invoke` at her agent with contracts; the Discovery Agent skill + handles on `discovery.registry`; tools `discover_agents`, `inspect_agent`, `engage`, `get_task`, `continue_task`; 349 §1b closed | live: alice, through Claude, finds Ligonier by intent (a capability filter that MATCHES) and engages it for a six-week study — the answer with links, her run's provenance naming the routed hop, the ministry's task; the twin: an outside agent's answer that claims an act is an observation, never a receipt |
| **W3 — authority through the host** | `authority_required` → `grant` link → she signs at her Home → `resume` finishes; progress notifications; elicitation for data prompts; runs labelled `via: home-mcp` on receipts and in the timeline | live: alice asks Claude to pay a treasury 1 USDC; the run parks; she grants at her Home (the persona path); Claude resumes; the receipt names the mandate and `via: home-mcp`; the twin: Claude's `resume` before she granted is `authority_required` again, never a payment |
| **W4 — trust and scale** | connected-apps row + revoke; 349 §2 relevance; the registry's `referral.receipt`; the public provenance pointer on every `engage` result (395); the nightly ledger rows; the connector install path documented for other hosts | the four gates nightly; a second MCP host (a stock client) completes W1's flow unchanged |

## 11. What this buys that option 1 cannot (the differentiation, stated so it can be checked)

| | AP Gateway (387) | Home MCP (this) |
| --- | --- | --- |
| Who is asking | nobody (the gateway, as itself) | Alice, through a client she authorized |
| Standing at a ministry | none; every act suspends for the target's stewards | hers — a member's or steward's, derived at the receiver (366) |
| Memory, playbook, private tier | none | hers (385/394/358 W5; her playbook's compiled asks) |
| Authority | never | hers — the run parks; she signs at her Home; the receipt names her mandate |
| Revocation | the operator revokes the gateway agent | Alice revokes one connected app on chain; the operator can still revoke `home-mcp.svc` |
| Provenance | the gateway's task | her run's graph, the routed hop a bundle `wasInformedBy` hers, `hasProvenance` + the public projection |
| What Claude sees | four tools | eight tools, the same four plus the Ask — and every reply says what it read and from which tier (C5) |

## Reference: patterns to port

- **Claude.ai custom connectors / the MCP authorization spec** — the shape of the door (PRM, DCR, PKCE, resource
  indicators) is adopted exactly; the token is a client credential, never authority.
- **spec 230's parallel delegation issuance** — the one thing OIDC providers never do (mint a caveated on-chain
  delegation beside the `id_token`) is the mechanism that makes a relying app's access revocable by the person on
  chain; the `ask-as-me` template is its narrowest instance.
- **spec 387's gateway** — the handle, the card re-fetch, the "never an endpoint in a result" rule, `continue_task`;
  kept as the entrance for a host that is nobody.
- **spec 372 S3c** — a second principal scheme with a per-request assertion spent once; `App-Delegation` is its
  third instance, with the person as delegator instead of the agent itself.
