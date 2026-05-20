# Audit / forensics trail — developer guide

This guide walks through adopting agenticprimitives' append-only audit trail in your own MCP server (or A2A worker, or any consumer of the platform's primitives). It pairs with [spec 206](../../../../specs/206-audit.md), which is the architect's design doc.

The canonical implementation lives in this app (`apps/demo-mcp/`) — `composeSinks(console, d1)` with a PII guardrail wrapped around the D1 sink, correlation-stitched across the a2a → mcp service boundary. You can run the demo, hit `/tools/get_profile`, then `wrangler d1 execute demo-mcp --remote --command "SELECT … FROM audit_events"` to see the trail.

## What you get

Every authority-bearing operation in the platform writes a structured audit row:

| Emitting package | Actions | Where |
| --- | --- | --- |
| `delegation` | `delegation.mint`, `delegation.verify.{accept,reject}` | All flows |
| `key-custody` | `key-custody.sign` (Local + GCP signers) | Signer ops |
| `mcp-runtime` | `mcp-runtime.with-delegation.{accept,reject}`, `mcp-runtime.service-mac.{accept,reject}` | MCP route entry |

Rows are correlation-stitched: demo-a2a generates an `X-Correlation-Id` per request, propagates it via header, demo-mcp threads it into every event written for that request. Querying by `correlation_id` reconstructs the full request path across both workers.

## Doctrine in 30 seconds

- **Append-only by interface.** The `AuditSink` interface has `write` only — no `delete` / `update`. Persistent sinks (D1, Postgres, etc.) enforce this at the schema level.
- **Fail-soft for the trail, fail-closed for the decision.** Emit failures NEVER throw to the caller. The decision itself is the security boundary, not the audit row.
- **No secret material in events.** Emitters MUST hash or omit raw secrets. The PII guardrail sink (`createPiiGuardrailSink`) is defense-in-depth, not a substitute for emitter discipline.
- **Correlation IDs are caller-supplied.** The package never generates correlation IDs on emit; consumers thread `X-Correlation-Id` request-to-emit.

## Setting up audit in your app

Five minutes, three steps. Patterns lifted directly from `apps/demo-mcp/src/index.ts`.

### 1. Compose your sinks

```ts
import {
  createConsoleAuditSink,
  createPiiGuardrailSink,
  composeSinks,
  type AuditSink,
} from '@agenticprimitives/audit';
import { createD1AuditSink } from './db';

function buildAuditSink(env: Env): AuditSink {
  return composeSinks(
    // Console for ops debugging via `wrangler tail`. Raw, unredacted —
    // log lines roll off.
    createConsoleAuditSink({ prefix: '[AUDIT mcp]' }),
    // Durable forensics sink, PII-guardrail-wrapped. D1 rows are forever
    // so a sloppy emit would otherwise poison the trail permanently.
    createPiiGuardrailSink(createD1AuditSink(env.DB), {
      mode: 'redact',
      onDetect: ({ event, findings }) => {
        console.warn(
          `[AUDIT] PII guardrail flagged event ${event.id}:`,
          findings.map((f) => `${f.path}=${f.reason}`).join(', '),
        );
      },
    }),
  );
}
```

### 2. Thread the sink into the verifier

```ts
import { withDelegation } from '@agenticprimitives/mcp-runtime';
import { getCorrelationId } from './helpers';

app.post('/tools/get_profile', async (c) => {
  const handler = withDelegation(
    baseConfig(c.env),
    async ({ principal }) => /* tool logic */,
    {
      toolName: 'get_profile',
      classification: GET_PROFILE_CLASSIFICATION,
      auditSink: buildAuditSink(c.env),
      correlationId: getCorrelationId(c),
    },
  );
  // ...
});
```

### 3. Extract the correlation ID

```ts
// Prefer X-Correlation-Id from the upstream caller; fall back to cf-ray
// for external clients that don't set it.
function getCorrelationId(c: Context): string | undefined {
  return c.req.header('X-Correlation-Id') ?? c.req.header('cf-ray') ?? undefined;
}
```

## D1 schema (if you want a durable sink)

```sql
CREATE TABLE IF NOT EXISTS audit_events (
  id              TEXT PRIMARY KEY,
  timestamp       TEXT NOT NULL,
  action          TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  correlation_id  TEXT,
  actor_type      TEXT,
  actor_id        TEXT,
  subject_type    TEXT,
  subject_id      TEXT,
  reason          TEXT,
  audience        TEXT,
  chain_id        INTEGER,
  digest          TEXT,
  context_json    TEXT
);
CREATE INDEX idx_audit_events_timestamp ON audit_events(timestamp DESC);
CREATE INDEX idx_audit_events_correlation ON audit_events(correlation_id);
CREATE INDEX idx_audit_events_action_outcome ON audit_events(action, outcome);
```

The schema mirrors the `AuditEvent` shape from `@agenticprimitives/audit`. Append-only is a convention enforced by your `createD1AuditSink` implementation — no `UPDATE` or `DELETE` statements anywhere in app code.

## Querying the trail

```bash
# Latest activity, correlation-stitched
wrangler d1 execute demo-mcp --env production --remote --command "
  SELECT timestamp, action, correlation_id, actor_id, subject_id
  FROM audit_events
  ORDER BY timestamp DESC
  LIMIT 20
"

# Reconstruct one request flow across services
wrangler d1 execute demo-mcp --env production --remote --command "
  SELECT timestamp, action, outcome, actor_id, subject_id, reason
  FROM audit_events
  WHERE correlation_id = 'a931b2d0-2356-…'
  ORDER BY timestamp
"

# Per-primitive accept rate (anomaly detection)
wrangler d1 execute demo-mcp --env production --remote --command "
  SELECT action,
         SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as accepts,
         COUNT(*) as total
  FROM audit_events
  WHERE timestamp > '2026-05-01'
  GROUP BY action
"
```

## PII guardrail behavior

When the guardrail catches a likely-secret value (long hex > 80 chars, JWT-shaped strings, PEM blocks, `private_key` / `client_secret` substrings) in a non-allowlisted position, it:

- In `mode: 'redact'` (default): replaces the field with `<redacted:<reason>:<preview>>`, forwards the sanitized event to the inner sink, calls `onDetect`.
- In `mode: 'drop'`: doesn't forward at all. Strictest.
- In `mode: 'warn'`: forwards unchanged. Use during roll-out to see what would be redacted.

Allowlisted context keys (hex passes through unchanged): `signerAddress`, `address`, `paymaster`, `entryPoint`, `keyId`, `nonceHash`, `sessionHash`, `digest`, `txHash`, `blockHash`, `jti`, `eventId`.

## What this guide doesn't cover

- **Cross-app destination unification** — demo-a2a is still console-only (no D1 binding). Spec 206 § 11 open question.
- **Identity-auth caller-emit pattern** — `identity-auth` itself is forbidden from importing `audit` per the dep doctrine; the consuming app emits at call sites. Demo doesn't exercise this yet.
- **Cloud Logging / Splunk / Datadog sinks** — straightforward to implement on top of `AuditSink`; not shipped.

## Related capabilities

- **Multi-sig + threshold policy** — when you ship multi-sig in your app, the same correlation IDs stitch threshold-approval flows. See [`apps/demo-web-pro/docs/multi-sig/guide.md`](../../../demo-web-pro/docs/multi-sig/guide.md).
