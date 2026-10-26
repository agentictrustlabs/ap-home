// AKCS (`agentic-kms`) configuration from the Worker env (spec 203 §4). Mirrors demo-a2a/src/akcs.ts —
// apps do not import each other (ADR-0021). Fail-closed: a missing AKCS_* value throws; no fallback.
import { loadSecret, staticTokenProvider, type AgenticKmsConfig, type AkcsProtectionLevel } from '@agenticprimitives/key-custody';

export interface AkcsEnv {
  A2A_KMS_BACKEND?: string;
  AKCS_BASE_URL?: string;
  AKCS_TENANT_ID?: string;
  /** Dev stacks: static token from the AKCS CLI; production: a workload TokenProvider. */
  AKCS_TOKEN?: string;
  AKCS_ACCEPTED_PROTECTION_LEVELS?: string;
  /** Protection level for the envelope keys this vault CREATES (per-person KEKs). Unset = the library's
   *  CVM_WRAPPED. A dev-local AKCS node (a local or staging estate) can only create DEV_LOCAL keys and
   *  refuses anything else, so such an estate sets DEV_LOCAL here — production leaves it unset. */
  AKCS_KEY_PROTECTION_LEVEL?: string;
}

export function isAgenticKms(env: { A2A_KMS_BACKEND?: string }): boolean {
  return env.A2A_KMS_BACKEND?.trim() === 'agentic-kms';
}

function required(env: AkcsEnv, name: keyof AkcsEnv): string {
  const v = env[name];
  if (!v) throw new Error(`[demo-mcp] A2A_KMS_BACKEND=agentic-kms requires ${name} (no fallback)`);
  return v;
}

export function agenticKmsConfig(env: AkcsEnv): AgenticKmsConfig {
  const levels = (env.AKCS_ACCEPTED_PROTECTION_LEVELS ?? 'CVM_DERIVED,CVM_WRAPPED').split(',').map((s) => s.trim()).filter(Boolean) as AkcsProtectionLevel[];
  return {
    baseUrl: required(env, 'AKCS_BASE_URL'),
    tenantId: required(env, 'AKCS_TENANT_ID'),
    tokenProvider: staticTokenProvider(loadSecret<'akcs-token'>(required(env, 'AKCS_TOKEN'))),
    acceptedProtectionLevels: levels,
  };
}
