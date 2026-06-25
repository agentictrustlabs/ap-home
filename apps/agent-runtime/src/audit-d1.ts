// Durable D1 audit sink for demo-a2a (spec 291 §6c). App-local (backend-specific
// sinks live with the consumer, per the audit package's boundary) but writes the
// SAME `audit_events` schema as demo-mcp, so A2A + MCP audit rows share one
// durable, queryable destination. Fail-soft: a write failure logs, never throws
// (compose with composeFailHardSinks for events whose absence must abort the op).
// Append-only by convention — INSERT only; no UPDATE/DELETE.

import type { AuditEvent, AuditSink } from '@agenticprimitives/audit';

export function createD1AuditSink(db: D1Database, table = 'audit_events'): AuditSink {
  return {
    async write(event: AuditEvent): Promise<void> {
      try {
        await db
          .prepare(
            `INSERT INTO ${table} (
              id, timestamp, action, outcome, correlation_id,
              actor_type, actor_id, subject_type, subject_id,
              reason, audience, chain_id, digest, context_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            event.id,
            event.timestamp,
            event.action,
            event.outcome,
            event.correlationId ?? null,
            event.actor?.type ?? null,
            event.actor?.id ?? null,
            event.subject?.type ?? null,
            event.subject?.id ?? null,
            event.reason ?? null,
            event.audience ?? null,
            event.chainId ?? null,
            event.digest ?? null,
            event.context ? JSON.stringify(event.context) : null,
          )
          .run();
      } catch (e) {
        console.error('[d1-audit-sink a2a] write failed:', e);
      }
    },
  };
}
