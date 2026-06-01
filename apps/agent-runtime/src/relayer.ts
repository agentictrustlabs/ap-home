// Demo-a2a relayer factory — KMS-backed funded signer for the 4
// non-identity-bearing operator routes.
//
// R5.12d / PKG-KEY-CUSTODY-009-+-010 / PKG-AGENT-ACCOUNT-005 closure.
//
// Pre-R5.12d, four routes (`/session/direct-deploy`, `/session/register-name`,
// `/session/custody-{schedule,apply}`, `/admin/topup-paymaster`) reached
// for `privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY)`. That tripped
// `check:no-app-private-keys` doctrine (chronic CI red) and emitted
// zero audit context tagged by operator role.
//
// Post-R5.12d, all four go through `getRelayerAccount(env, role, auditSink)`:
//   - `A2A_KMS_BACKEND` picks the KMS backend (same env var the UserOp
//     relayer path already uses — `local-aes` for testnet,
//     `gcp-kms` for production)
//   - `createRelayerAccount(backend, { role, auditSink })` emits
//     `key-custody.relay.sign` on every signed op tagged by role
//   - The paymaster top-up additionally wraps with
//     `createSpendCappedAccount({ capWei })` so a compromised app process
//     cannot drain the worker balance past the per-tx cap. The cap is
//     enforced BEFORE the HSM round-trip (see `docs/spend-capped.md` in
//     @agenticprimitives/key-custody).
//
// Identity-vs-relayer distinction:
//   None of the four routes use the relayer as the IDENTITY-BEARING
//   signer. The contract authorizations in each case rest on:
//     - SIWE-verified wallet (direct deploy: target SA derived via
//       `assertSaMatchesCustodianDerivation` from the verified wallet
//       BEFORE the relayer signs)
//     - PermissionlessSubregistry's anyone-can-call `register(label, owner)`
//       (register-name: the owner is the just-deployed SA, not the
//       relayer)
//     - Custody-quorum sigs over an EIP-712 hash (custody-{schedule,
//       apply}: the relayer is only paying gas; msg.sender is unchecked)
//     - Paymaster owner (top-up: ETH transfer to the EntryPoint deposit;
//       SpendCap blocks a draining tx pre-HSM)
//
// Operational note (testnet):
//   On `local-aes` backend, `createRelayerAccount` uses
//   `LocalSecp256k1Signer` backed by `A2A_MASTER_PRIVATE_KEY`. The
//   address derived from that key must be funded with Base Sepolia ETH.
//   This replaces the old `DEPLOYER_PRIVATE_KEY` funding requirement.

import {
  buildSignerBackend,
  createRelayerAccount,
  createSpendCappedAccount,
  type KmsBackend,
} from '@agenticprimitives/key-custody';
import type { AuditSink } from '@agenticprimitives/audit';
import type { LocalAccount } from 'viem';

/** Conventional role tags emitted into every relayer audit row. */
export type RelayerRole =
  | 'direct-deploy'
  | 'register-name'
  | 'custody-relay'
  | 'paymaster-topup';

/** Minimal env shape this module needs — keeps it decoupled from index.ts. */
export interface RelayerEnv {
  A2A_KMS_BACKEND?: string;
  PAYMASTER_TOPUP_CAP_WEI?: string;
}

/**
 * Default per-tx cap for the paymaster top-up signer when
 * `PAYMASTER_TOPUP_CAP_WEI` is unset. 0.002 ETH matches the
 * existing demo-a2a per-call cap and the route's documented
 * "topup ≤ 0.002 ETH" promise. Override via env when running on a
 * higher-traffic deployment.
 */
export const DEFAULT_PAYMASTER_TOPUP_CAP_WEI = 2_000_000_000_000_000n; // 0.002 ETH

function resolveBackend(env: RelayerEnv): KmsBackend | undefined {
  // Empty-string is a misconfiguration, not a default. Pass `undefined`
  // through to `buildSignerBackend` so the package-level fail-closed
  // guard in @agenticprimitives/key-custody (factories.ts:backendOrEnv)
  // owns the production-vs-dev decision — no silent fallback at this
  // layer (ADR-0013 / feedback_no_silent_fallbacks). The wrangler.toml
  // EXPLICIT default for testnet is `A2A_KMS_BACKEND = "local-aes"`.
  const raw = env.A2A_KMS_BACKEND;
  if (!raw) return undefined;
  return raw as KmsBackend;
}

/**
 * Return a viem `LocalAccount` for a funded relayer / operator role.
 *
 * Routes that send funded chain calls reach for this instead of
 * `privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY)`. The role tag lands
 * in every emitted `key-custody.relay.sign` audit row.
 */
export async function getRelayerAccount(
  env: RelayerEnv,
  role: Exclude<RelayerRole, 'paymaster-topup'>,
  auditSink: AuditSink,
): Promise<LocalAccount> {
  const backend = buildSignerBackend({
    backend: resolveBackend(env),
    auditSink,
  });
  return createRelayerAccount(backend, { role, auditSink });
}

/**
 * Return a spend-capped relayer for the paymaster top-up endpoint.
 *
 * Composes `createRelayerAccount({ role: 'paymaster-topup' })` with
 * `createSpendCappedAccount({ capWei: PAYMASTER_TOPUP_CAP_WEI })` so
 * a single tx cannot drain the worker beyond the cap, even if the app
 * process is compromised. The cap rejection happens BEFORE any HSM
 * round-trip.
 */
export async function getPaymasterTopupAccount(
  env: RelayerEnv,
  auditSink: AuditSink,
): Promise<LocalAccount> {
  const capWei = env.PAYMASTER_TOPUP_CAP_WEI
    ? BigInt(env.PAYMASTER_TOPUP_CAP_WEI)
    : DEFAULT_PAYMASTER_TOPUP_CAP_WEI;
  const backend = buildSignerBackend({
    backend: resolveBackend(env),
    auditSink,
  });
  const inner = await createRelayerAccount(backend, {
    role: 'paymaster-topup',
    auditSink,
  });
  return createSpendCappedAccount(inner, { capWei, auditSink });
}
