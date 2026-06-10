# demo-a2a

**The agent boundary: where a browser session becomes bounded machine authority.**

Every agentic stack has a moment where a human's intent crosses into autonomous execution. Most stacks cross it with an API key. This Cloudflare Worker is the [agenticprimitives](../../README.md) answer: the A2A boundary where sessions are verified, Smart Agent calls are relayed gas-free, and downstream MCP access is minted as **delegation tokens — scoped, replay-protected, revocable — never keys**.

## The chain it proves

> Browser sign-in (SIWE or passkey) → verified session → gasless Smart Agent deploys and UserOps via the relayer → delegation-token minting → proxied MCP tool calls under the same delegation the user signed.

Concretely, this Worker:

- **Verifies authentication** — SIWE (including on-chain ERC-1271/ERC-6492 signature verification for smart accounts) and custody-grade sessions, with CSRF and origin enforcement.
- **Relays on-chain actions** — builds and submits Smart Agent deploys, batched executes, and paymaster-sponsored UserOps so demo users never need gas.
- **Holds session state in a Durable Object** — per-user sessions live in `SessionStoreDO`; signing keys are handled through the KMS abstraction, not ambient environment access.
- **Mints `DelegationToken` envelopes** — the bridge from a user-signed EIP-712 delegation to a bounded, JTI-tracked token a downstream MCP server can verify independently.
- **Proxies MCP vault and tool calls** — the same Worker fronts [`demo-mcp`](../demo-mcp) for the browser apps, so every tool call arrives delegation-first.

Every browser demo in this repo — [`demo-web`](../demo-web), [`demo-web-pro`](../demo-web-pro), [`demo-sso`](../demo-sso), [`demo-org`](../demo-org), [`demo-gs`](../demo-gs) — routes its `/a2a/*` traffic here. One boundary, one authority model.

## Packages composed

- [`@agenticprimitives/a2a`](../../packages/a2a) — agent-to-agent primitives, agent cards
- [`@agenticprimitives/connect-auth`](../../packages/connect-auth) — SIWE verify, session mint/verify, CSRF
- [`@agenticprimitives/agent-account`](../../packages/agent-account) — account client, batched execute calldata
- [`@agenticprimitives/delegation`](../../packages/delegation) — delegation verification + token envelopes
- [`@agenticprimitives/key-custody`](../../packages/key-custody) — KMS-backed signers, envelope encryption, MAC providers
- [`@agenticprimitives/agent-naming`](../../packages/agent-naming) — name registration calls, host resolution
- [`@agenticprimitives/connect`](../../packages/connect) / [`audit`](../../packages/audit) / [`mcp-runtime`](../../packages/mcp-runtime) / [`types`](../../packages/types)

## Run it

```bash
# Everything at once, from the repo root:
pnpm dev

# Or just this Worker:
pnpm dev:a2a    # wrangler dev on http://127.0.0.1:8787
```

Local secrets and contract addresses come from `.dev.vars` (wrangler convention). Deploy with `pnpm --filter @agenticprimitives-demo/a2a deploy`.

## Status

Reference implementation, not a product. Runs live against Base Sepolia (chain 84532) and local Anvil. The relayer and demo session secrets are development-grade by design — production custody is the job of [`key-custody`](../../packages/key-custody)'s KMS backends. Production launch of the substrate is gated on the public checklist in the [root README](../../README.md); findings are tracked live in [`docs/audits/findings.yaml`](../../docs/audits/findings.yaml).

Validate: `pnpm check:demo-a2a`.
