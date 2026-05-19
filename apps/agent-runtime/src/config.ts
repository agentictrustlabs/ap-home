// Demo-a2a config loader. Reads env vars + the deployments JSON written by
// apps/contracts/script/Deploy.s.sol. Fails fast at boot if required env is
// missing.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Address } from '@agenticprimitives/types';

export interface DemoA2aConfig {
  port: number;
  rpcUrl: string;
  chainId: number;
  allowedOrigins: string[];
  deployments: {
    entryPoint: Address;
    delegationManager: Address;
    agentAccountFactory: Address;
    timestampEnforcer: Address;
    allowedTargetsEnforcer: Address;
    allowedMethodsEnforcer: Address;
    valueEnforcer: Address;
  };
}

function require_(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`demo-a2a: missing required env ${name}`);
  }
  return v;
}

function loadDeployments(): DemoA2aConfig['deployments'] {
  const network = process.env.DEPLOY_NETWORK ?? 'anvil';
  const path = join(
    process.env.DEPLOYMENTS_DIR ?? join(process.cwd(), '..', 'contracts'),
    `deployments-${network}.json`,
  );
  if (!existsSync(path)) {
    throw new Error(
      `demo-a2a: deployments file not found at ${path}. Run \`pnpm dev:contracts\` (or set DEPLOYMENTS_DIR).`,
    );
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  return {
    entryPoint: raw.entryPoint as Address,
    delegationManager: raw.delegationManager as Address,
    agentAccountFactory: raw.agentAccountFactory as Address,
    timestampEnforcer: raw.timestampEnforcer as Address,
    allowedTargetsEnforcer: raw.allowedTargetsEnforcer as Address,
    allowedMethodsEnforcer: raw.allowedMethodsEnforcer as Address,
    valueEnforcer: raw.valueEnforcer as Address,
  };
}

export function loadConfig(): DemoA2aConfig {
  // Required for identity-auth and key-custody, regardless of demo state:
  require_('SESSION_JWT_SECRETS');
  require_('CSRF_SECRET');
  require_('A2A_SESSION_SECRET');
  require_('A2A_MASTER_PRIVATE_KEY');

  return {
    port: Number(process.env.PORT ?? 8787),
    rpcUrl: process.env.RPC_URL ?? 'http://127.0.0.1:8545',
    chainId: Number(process.env.CHAIN_ID ?? 31337),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(','),
    deployments: loadDeployments(),
  };
}
