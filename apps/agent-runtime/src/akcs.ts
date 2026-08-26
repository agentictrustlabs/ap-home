// AKCS (`agentic-kms`) configuration from the Worker env — spec 203 §4 env contract.
//
// Explicit and fail-closed: when `A2A_KMS_BACKEND=agentic-kms` every AKCS_* value below is required and
// a missing one throws at first use (no fallback to local-aes / gcp-kms — ADR-0013). The dev stack sets
// AKCS_TOKEN to a short-lived static token minted by the AKCS CLI (`faithkms: just demo-stack-init`);
// a real deployment wires a workload TokenProvider instead of a static secret.

import {
  loadSecret,
  staticTokenProvider,
  type AgenticKmsConfig,
  type AkcsProtectionLevel,
  type AkcsSigningPurpose,
  type KmsBackend,
} from '@agenticprimitives/key-custody';

export interface AkcsEnv {
  A2A_KMS_BACKEND?: string;
  AKCS_BASE_URL?: string;
  AKCS_TENANT_ID?: string;
  /** Bearer token for the AKCS audience. Dev stacks: static; production: replace with a TokenProvider. */
  AKCS_TOKEN?: string;
  /** Comma-separated. Defaults to the CVM levels; the local stack sets DEV_LOCAL explicitly. */
  AKCS_ACCEPTED_PROTECTION_LEVELS?: string;
  /** AKCS SIGNING key id the relayer signs with (`buildSignerBackend` → `config.agenticKeyId`). */
  AKCS_RELAY_KEY_ID?: string;
}

export function kmsBackendOf(env: { A2A_KMS_BACKEND?: string }): KmsBackend | undefined {
  const raw = env.A2A_KMS_BACKEND?.trim();
  return raw ? (raw as KmsBackend) : undefined;
}

export function isAgenticKms(env: { A2A_KMS_BACKEND?: string }): boolean {
  return kmsBackendOf(env) === 'agentic-kms';
}

function required(env: AkcsEnv, name: keyof AkcsEnv): string {
  const v = env[name];
  if (!v) throw new Error(`[demo-a2a] A2A_KMS_BACKEND=agentic-kms requires ${name} (no fallback)`);
  return v;
}

export function agenticKmsConfig(
  env: AkcsEnv,
  opts: { envelopePurpose?: string; signingPurpose?: AkcsSigningPurpose; chainId?: number } = {},
): AgenticKmsConfig {
  const levels = (env.AKCS_ACCEPTED_PROTECTION_LEVELS ?? 'CVM_DERIVED,CVM_WRAPPED')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as AkcsProtectionLevel[];
  return {
    baseUrl: required(env, 'AKCS_BASE_URL'),
    tenantId: required(env, 'AKCS_TENANT_ID'),
    tokenProvider: staticTokenProvider(loadSecret<'akcs-token'>(required(env, 'AKCS_TOKEN'))),
    acceptedProtectionLevels: levels,
    ...(opts.envelopePurpose ? { envelopePurpose: opts.envelopePurpose } : {}),
    ...(opts.signingPurpose ? { signingPurpose: opts.signingPurpose } : {}),
    ...(opts.chainId ? { chainId: opts.chainId } : {}),
  };
}
