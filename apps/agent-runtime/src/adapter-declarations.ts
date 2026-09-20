import type { AdapterDeclarationV1 } from '@agenticprimitives/orchestration';

// Spec 410 §2 — WHAT EACH BUILT-IN ADAPTER DECLARES. Facts about the adapter, stated by the app that owns it, never
// inferred from a response. `verificationWindow` is the time between the harness's check and the provider's
// commit; `retry` what a second identical call does (the on-chain nonce and the operation ledgers make the
// families below idempotent by key); `cancellation` what a cancel can do — `none` keeps the word out of every
// projection of that tool.
export const ADAPTER: Record<'chain' | 'sync' | 'external' | 'unknown', AdapterDeclarationV1> = {
  /** A userOp the bundler client waits on: one block between the check and the commit; a mined tx cannot be cancelled. */
  chain: { verificationWindow: 'PT15S', retry: 'idempotent-by-key', cancellation: 'none' },
  /** The sender's or the person's own object, synchronous: delivered-or-refused, recorded-or-refused. */
  sync: { verificationWindow: 'PT0S', retry: 'idempotent-by-key', cancellation: 'none' },
  /** An outside provider that answers synchronously and keeps what it made (a PR, an event, a sent mail). */
  external: { verificationWindow: 'PT0S', retry: 'never', cancellation: 'none' },
  /** An outside MCP server nobody here vouches for: the window is whatever it is, and a second call is a second call. */
  unknown: { verificationWindow: 'unbounded', retry: 'never', cancellation: 'none' },
};
