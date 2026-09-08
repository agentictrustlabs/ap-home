# Spec 375 — A second model behind the same port: the person picks, the deployment offers, nothing swaps

**Status:** W1 — adapter + app wiring + Home picker (this change) · **Kind:** Ring-0 adapter package, harness configuration, a Home surface control
**Grounds:** [ADR-0044](../docs/architecture/decisions/0044-a2a-is-the-agentic-orchestration-layer.md) §5 (orchestration is Ring-0; ONLY the concrete LLM binding is an isolated in-repo adapter behind the planner port — the `chain-state` / `chain-state-viem` pattern) · [principles](../docs/architecture/principles.md) §1/§4 (an in-repo LLM adapter is as legitimate as the in-repo `viem` adapter) · [ADR-0013](../docs/architecture/decisions/0013-no-silent-fallbacks.md) (one mechanism; empty is an answer, not a trigger) · [`orchestration-anthropic/spec.md`](../packages/orchestration-anthropic/spec.md) §6 ("non-Anthropic vendors: separate sibling adapters") · [367](367-behaviour-plane-first-time-right.md) wave 1 (the planner trace says which planner proposed) · [369](369-voice-as-an-ask-facet.md) (a header control on the Ask that changes HOW a turn is served, never WHAT it may do)

## 0. The gap

The Home Ask plans, composes and runs its grounded lookups through one vendor. Which vendor is a deployment
fact (`ORCHESTRATION_LLM=anthropic` + a key), the same for every person on that Home, and invisible to them
until the "How" pane names the planner after the fact. There is no way to run an Ask on a free model, and no
way for a person to choose.

## 1. The rule, stated once

**The port does not move; a vendor is an adapter; the person picks per conversation; an unavailable or
unknown choice is refused, never swapped.**

- `orchestration.Planner` and `orchestration.AnswerComposer` are the ports. A vendor implements them in its
  own package. The loop, admission, authority and the trace never learn a vendor's name except as a label.
- A deployment OFFERS an ordered list of providers. The first is the default. Each offered provider needs its
  own credential; a provider that is offered and not credentialed is a configuration error that throws on the
  first turn that needs it (the existing `llmConfigured` rule, per provider).
- A turn NAMES the provider it wants. Absent ⇒ the default. A name the deployment does not offer ⇒ HTTP 400
  with the offered list in the message. At no point does a request for one provider run on another.
- The choice governs the WHOLE turn: the planner, the answer composer and the structured lookup call. One
  choice, one bill, one trace line.

## 2. The adapter package — `@agenticprimitives/orchestration-openai-compat`

A sibling of `orchestration-anthropic`, file for file, speaking the OpenAI-compatible chat-completions wire
(`POST {baseUrl}/chat/completions`, `tools[].function`, `tool_choice`, `choices[0].message.tool_calls`).

- **Vendor-neutral.** The package names no host and no model: `createFetchOpenAiCompatClient` REQUIRES
  `baseUrl`; `createOpenAiCompatPlanner` / `Composer` / `StructuredCall` REQUIRE `model`. Groq, Ollama,
  OpenRouter and any compatible host are the CONSUMER's configuration. A `label` (default `openai-compat`)
  names the consumer in rationales and errors.
- **Structural client.** `OpenAiCompatLike { chat: { completions: { create } } }`, so the real `openai` SDK,
  our fetch client, or a test fake all satisfy it. No SDK dependency.
- **Arguments are a JSON string on this wire.** The adapter parses them; an unparseable or non-object payload
  is `OrchestrationError('planner_failed')`, never a silent `{}`. Empty is `{}`.
- **`tool_choice: 'required'` is a request, not a guarantee.** No `tool_calls` ⇒ `OrchestrationError('no_plan')`
  — the same backstop the Anthropic adapter has.
- **The plan-shape convention is shared.** `wireNameFor` / `toolNameMap` (dotted ids → API-safe names, collisions
  refused) and `planStepFromToolArgs` (`$ref` / `$forEach` / `$after` / `$when` lifted out of the args) move
  into `packages/orchestration` and BOTH adapters import them. The convention belongs to the loop that reads
  it, not to whichever vendor happened to ship first.
- **Non-streaming, stated.** The Anthropic client streams because a 100s+ blocking request was killed by an
  intermediary (HTTP 524). The Ask's budgets are 1024 / 700 tokens; streaming this client is a follow-up.
- **Rate limits surface.** A non-OK response is `OpenAiCompatHttpError { status, retryAfterSeconds?, detail }`.
  A 429 on the planner is a refused turn carrying the provider's message; a 429 on the composer leaves the
  evidence floor (spec 358 W3) in place AND says why. Neither reroutes to another vendor.

## 3. Deployment configuration (demo-a2a)

| Var / secret | Meaning |
| --- | --- |
| `ORCHESTRATION_LLM` | Comma-separated, ORDERED allowlist of providers (`anthropic`, `groq`). First = default. A single `anthropic` behaves exactly as before. An unknown entry throws (a typo must not silently drop a model). |
| `ANTHROPIC_API_KEY` (secret) | Required when `anthropic` is listed. |
| `GROQ_API_KEY` (secret) | Required when `groq` is listed. |
| `ORCHESTRATION_MODEL` | Anthropic model override (unchanged). |
| `ORCHESTRATION_GROQ_MODEL` | Groq model. Default `openai/gpt-oss-120b` (the free catalog's strongest tool-calling model; the Llama 3.x ids were retired from it) (in `src/orchestration.ts` `GROQ_DEFAULTS`, the APP, never the package). |
| `ORCHESTRATION_GROQ_BASE_URL` | Default `https://api.groq.com/openai/v1` (same place). |

`availableModels(env)` is what a deployment OFFERS: the allowlisted providers that are credentialed. A listed
but keyless provider is omitted from the offer (so the surface does not show a choice that cannot be served)
and throws on a turn that names it directly (so a hand-crafted request cannot land on the default).

## 4. The wire

- `POST /harness/ask` body: `model?: string` — the provider id for this turn. Validated by `resolveProvider`
  BEFORE any run state is touched; `{ ok: false }` ⇒ 400 `model "x" is not offered by this agent; offered: a, b`.
- `GET /harness/vocabulary`: `models: Array<{ id, label, model, free, default }>` — the offer, read without a
  session for the same reason the capability list is.
- `PlannerTraceV1.planner` gains `'groq'`; `PlannerTraceV1.model?: string` names the concrete model that
  planned. Display only; no gate reads it.

## 5. The surface (Home)

A `<select data-testid="ask-model">` in the Ask header, between Voice and How, rendered only when the agent
offers more than one model. The pick is remembered per browser (`localStorage['ask.model']`) and sent on every
turn of a run, so a resume composes with the same provider. The How pane renders
`planner groq(openai/gpt-oss-120b)`. Authority is unchanged whichever is picked — the control changes who
proposes, never what is permitted (369's rule for voice, applied to the model).

## 6. Out of scope / follow-ups

- Streaming for the OpenAI-compatible client.
- Persisting the provider in the run checkpoint (today the composer of a resumed run uses whatever the
  resuming turn names; the trace shows it).
- A2A skills choosing a provider (they keep the deployment default; their `kind === 'anthropic'` branches
  become `kind !== 'rule-based'` so a non-Anthropic default can never silently degrade to templates).
- Prompt tuning for Llama on the harness contract; measure with the spec 367 scenario evals first.

## 7. Reference: smart-agent patterns to port

None. `smart-agent` has no multi-provider planner; this ports the repo's own `chain-state` / `chain-state-viem`
adapter pattern sideways.
