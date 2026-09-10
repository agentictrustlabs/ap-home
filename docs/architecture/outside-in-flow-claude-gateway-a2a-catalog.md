# The outside-in flow: Claude.ai → AP Gateway → registry → the ministry's agent → its catalog

**Status:** live 2026-09-10 (specs [386](../../specs/386-external-assistant-discovery-connector.md) + [387](../../specs/387-ap-gateway-mcp-facade-of-a2a.md) W1–W2) · **Gate:** `scripts/trace-ap-gateway.mts` (one live run, every hop's output printed) · **Instrumentation:** the flow trace (§4)

This document describes ONE exact flow, the way it runs today, and how to see what each hop did. The
transcript it explains: a person asks Claude.ai for "a six-week study on justification"; Claude.ai gets
back a study made only of Ligonier Ministries' own catalog items, each with its link, composed by
Ligonier's own agent. Nothing of ours reads, relays or summarizes the ministry's content.

## 1. The picture

```mermaid
sequenceDiagram
    autonumber
    participant C as Claude.ai (MCP host)
    participant G as AP Gateway<br/>gc-discovery-connector (MCP server)
    participant R as Discovery registry<br/>discovery-a2a.faithnet.io (ARD)
    participant E as Edge + A2A Worker<br/>edge.faithnet.io → demo-a2a-faithnet
    participant A as ligonier.svc's run<br/>(playbook content-catalog)
    participant K as Content catalog MCP<br/>gc-ligonier-catalog (profile v1)

    C->>G: tools/call discover_agents {topic, capability}
    G->>R: POST /search (deterministic ARD body)
    R-->>G: entries (score = relevance only)
    G->>E: GET /.well-known/agent-card.json (per entry)
    G-->>C: agents[{name, card, target: HMAC handle}], trace.hops[gateway.discover]
    C->>G: tools/call inspect_agent {target}
    G->>E: GET card (re-read, digest vs pin)
    G-->>C: card facts, cardMatchesPin, trace.hops[gateway.inspect]
    C->>G: tools/call invoke_agent {target, message, flow}
    G->>E: GET card (endpoint must equal the pinned one)
    G->>E: A2A SendMessage as gateway.svc (signed; session wire pinned to harness.ask; metadata.flowId)
    E->>E: admission: signature → session wire → principal gateway.svc
    E->>A: runAgentAsk (unattended run at ligonier.svc)
    A->>A: loadPlaybook (archetype.assignment, digest-checked) → planner (tools offered incl. catalog.*)
    A->>K: POST /mcp tools/call search_resources {topic, limit}  (endpoint = name record atl:mcpEndpoint)
    K-->>A: {total, resources[], types} — metadata only
    A->>A: composer (grounded on the catalog evidence) → the study
    A-->>E: task COMPLETED: words + artifacts[results, trace]
    E-->>G: JSON-RPC result.task
    G-->>C: {agent, task{text, artifacts}, trace{flowId, hops[gateway.card, gateway.invoke, agent.run]}}
```

Three Workers on two Cloudflare accounts take part: the gateway and the catalog on the richcanvas account
(`gc-discovery-connector`, `gc-ligonier-catalog`), the edge, the A2A Worker and the registry on the
faithnet account (`demo-edge-faithnet`, `demo-a2a-faithnet`, `demo-discovery-a2a-faithnet`). Claude.ai is
the only party that is not ours.

## 2. Each hop: transport, identity, authority, what it returns

| # | Hop | Transport | Who speaks as whom | What authorizes it | Returns |
| --- | --- | --- | --- | --- | --- |
| 1 | Claude.ai → gateway | MCP, stateless Streamable HTTP (`POST /mcp`) | the host; no user identity crosses | nothing — public, rate-limited at the edge | tool results (`structuredContent`) |
| 2 | gateway → registry | HTTPS `POST /search` (ARD) | anonymous | nothing — the KB is world-readable by construction (ADR-0040) | entries: identifier, card URL, capabilities, `ap:*` facts, relevance score |
| 3 | gateway → card | HTTPS GET, `/.well-known/agent-card.json` | anonymous | nothing; the card's sha256 is pinned in the handle | name, skills, A2A interface → the endpoint |
| 4 | gateway → agent | A2A 1.x JSON-RPC `SendMessage` over the edge | **gateway.svc** (its own estate agent), signed by the Worker's key under a session wire the custodian (alice) signed, pinned to `harness.ask` | the edge admits the signature + wire (ADR-0057); the wire is revocable on chain | the task: status, words, artifacts |
| 5 | agent run | in-process (`standard-a2a.ts` → `runAgentAsk`) | ligonier.svc, for an outside principal (unattended: no session, no vault, no acts) | the playbook narrows what is OFFERED; a read runs no gate; an act would park for a steward (spec 372 N1) | reply + events + planner trace |
| 6 | agent → catalog | MCP `POST /mcp tools/call` at the name record `atl:mcpEndpoint` | anonymous (public metadata) | nothing — the catalog decides nothing about anyone | `{total, resources[], types, filters}` |
| 7 | composer | LLM call (provider = the deployment's default) | — | grounded on the step evidence (spec 358 W3) | the words |

Two rules the table encodes. **Records first:** hops 3, 4 and 6 go where the NAME's published records say —
`atl:cardUri`/`a2aEndpoint` for the card and the A2A endpoint, `atl:mcpEndpoint` for the catalog — never a
hostname convention, never a config of ours. **Authority is spent nowhere:** the only signature in the flow
is the gateway's own (hop 4), and it authorizes a conversation, not an act; the catalog read is public; the
composer's words are checked against evidence, not trusted.

## 3. What the code is (symbol by symbol)

| Box | Symbol | Where |
| --- | --- | --- |
| gateway tools | `discoverAgents` · `inspectAgent` · `invokeAgent` · `getTaskTool` | `apps/demo-discovery-connector/src/gateway/tools.ts` |
| handle | `mintHandle` / `verifyHandle` (HMAC over anchor, name, cardUrl, endpoint, cardDigest, registry; 24 h) | `gateway/handle.ts` |
| A2A client | `fetchCard` · `sendMessage` (metadata.flowId) · `translateTask` · signed headers via `wrapSessionSignature` | `gateway/a2a-client.ts` |
| registry search | `planFindServices` (deterministic ARD body) · `findServices` | `src/plan.ts`, `src/catalog.ts` |
| edge admission | signature → `sessionWirePrincipal` → principal | `apps/demo-edge`, `packages/a2a/src/standard/*` |
| the agent's surface | the `harness.ask` executor: `askAsAgent` → `runAgentAsk`; `trace` + `results` artifacts | `apps/demo-a2a/src/standard-a2a.ts` |
| the run | `runUnderMandate` → `loadPlaybook` → planner → `harnessInvoker` → `askReplyFor` | `apps/demo-a2a/src/harness-run.ts` |
| the catalog binding | `catalogBindingFor` (nameOf → `readNameRecords` → `mcpEndpoint`) · `CATALOG_TOOLS` · `catalogInvoker` | `apps/demo-a2a/src/catalog-tools.ts` |
| the content MCP | `searchResources` · `listTopics` · `getResource`; profile `TOOLS` | `apps/demo-content-catalog/src/{catalog,profile,index}.ts` |
| the playbook | archetype `content-catalog` + skills `catalog-resource-search/topic-list/resource-get` | `~/skills/archetypes/content-catalog`, `~/skills/skills/agentic-trust/catalog-*` |
| the trace | `buildFlowTrace` · `flowIdOf` (agent side); `flowIdFor` · `logHop` (gateway side) | `apps/demo-a2a/src/flow-trace.ts`, `gateway/tools.ts` |

## 4. Instrumentation: the flow trace

The flow was three Workers' logs on two accounts. Now every tool result carries `trace`, and the same id
joins the logs:

- **One flow id per assistant turn.** `discover_agents` mints `trace.flowId` (`fl-…`) or echoes the `flow`
  argument; the host passes it to `inspect_agent` and `invoke_agent`. The gateway puts it on the A2A
  message (`metadata.flowId`); the agent echoes it in its trace and in its log line.
- **Gateway hops** (`trace.hops[]`, each `{hop, ms, request, response}`): `gateway.discover` (registry, the
  exact query, results, cards), `gateway.inspect` (card URL, name, endpoint, `cardMatchesPin`),
  `gateway.card` (the re-read before sending), `gateway.invoke` (endpoint, `as`, method, chars →
  taskId, state, artifact names, chars, needs).
- **The agent's hop** (`agent.run`, the task's `trace` artifact lifted into the same list — `ap.flow-trace.v1`):
  `runRef`, `playbook {archetypeId, digest}`, `planner {kind, model, toolsExposed, plan, admission}`,
  `steps[{toolId, ok, args, output}]`, `reply {kind, chars, artifacts}`, `events[]` (the run's `RunEvent`s
  in order), `ms`. A step's `output` is a SUMMARY: counts, totals, flags and its `source` — never the rows.
- **The catalog's hop** rides on the step's `output.source`: `{agent, catalog, profile, tool, args, ms}` —
  which MCP tool was called at which endpoint with which arguments, and how long the catalog took. The rows
  themselves are the task's `results` artifact (the deliverable), not the trace.
- **Logs.** `[flow <id>] gateway.discover 4991ms {…}` on the gateway; `[flow <id>] agent 0x… run svc-… ←
  0x…: answer · planner groq · steps catalog.resource.search · 15221ms` on the A2A Worker;
  `[content-catalog] tools/call search_resources {…}` on the catalog. Tail them with
  `wrangler tail gc-discovery-connector` / `gc-ligonier-catalog` (richcanvas token in the environment) and
  `CLOUDFLARE_ACCOUNT_ID=5da2… wrangler tail demo-a2a-faithnet`, and grep the flow id.

**What a trace is not.** Evidence of what ran. It carries no mandate, no wire, no session, no vault record,
and no row of anyone's data; a caller who could act on it could act without it.

## 5. Reading a run (measured 2026-09-10, flow `fl-ef3bbc37`)

`TRACE=1 npx tsx scripts/trace-ap-gateway.mts` runs the flow once (the wave's one live call) and prints
the tree. The run below is the live one, verbatim except for trimming:

```
▶ discover_agents   gateway.discover   2906 ms  in {registry: discovery-a2a.faithnet.io/search, query: {text: justification, capability: gc:CFnDiscipleshipCurricula}}
                                                out {results: 1, withTarget: 1, cards: [ligonier-svc.faithnet.ai/.well-known/agent-card.json]}
▶ inspect_agent     gateway.inspect     164 ms  out {name: ligonier.svc, endpoint: edge.faithnet.io/api/a2a/ligonier.svc, cardMatchesPin: true}
▶ invoke_agent      gateway.card        157 ms  out {endpoint …, cardMatchesPin: true}
                    gateway.invoke    28684 ms  in {as: 0x3d9af0… (gateway.svc), method: SendMessage}  out {state: COMPLETED, artifacts: [trace, results], chars: 1873}
                    agent.run         27788 ms  run svc-6005c0cb… at 0x38b502cd… (flow echoed: true)
                      playbook  skill:archetypes/content-catalog 0x88417e01dc…
                      planner   groq (openai/gpt-oss-120b) · offered 21 tools · plan [{catalog.resource.search, {topic: justification, limit: 100}}]
                      step      catalog.resource.search ok
                        └─ MCP tools/call search_resources @ gc-ligonier-catalog…/mcp  51 ms → {count: 50, total: 240, types: {devotional: 90, teaching-series-message: 54, article: 24, …}}
                      composer  reply answer, 1873 chars · events RunStarted → PlanCreated → StepProposed → ToolInvoked → ReceiptCreated → RunCompleted
── what Claude.ai receives ── words: six weeks, two linked items each · results artifact: 50 linked items · trace artifact: yes
```

Things the tree shows that a transcript cannot: the planner asked for 100 items and the catalog capped it
at 50 (the profile's maximum); the catalog answered in 51 ms of a 28 s task — the time is the two model
calls; the study's every link is one of the 50 rows in the artifact; and the flow id the host minted at
`discover_agents` is the one the agent echoed.

A failure prints where it happened, in the hop's own words. The first instrumented run (2026-09-10,
`fl-7cb17465`) stopped at `agent.run` with `planner_failed: anthropic messages.create failed (HTTP 400):
credit balance is too low` — the deployment's default planner was Anthropic and the account was out of
credit; the transcript alone would have said "the agent did not answer". Groq leads on faithnet until
credits are added (`ORCHESTRATION_LLM = "groq,anthropic"`).

## 6. Limits, stated

- The catalog hop is anonymous. Right for public metadata; wrong the day a catalog serves anything else —
  W3 signs it with the agent's own session wire.
- The planner picks the search `limit` (20 of 240 today); a plan wants a wider read.
- The reply length is a deployment setting (`COMPOSER_MAX_TOKENS`, 2400 on faithnet); the composers'
  default (700) cut a six-week study at week three.
- The gateway holds the flow id only for the duration of a tool call; joining a full assistant turn is the
  host's job (it passes `flow`). Claude.ai does today when told to in the tool descriptions.
- The trace lists steps from `ToolInvoked` events; a step the admission refused appears under
  `planner.admission`, not under `steps`.
