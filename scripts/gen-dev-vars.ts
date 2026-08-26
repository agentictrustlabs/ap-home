/**
 * gen-dev-vars.ts
 *
 * Reads packages/contracts/deployments-<network>.json (written by the forge
 * deploy script) and emits .dev.vars files for the demo Workers so
 * `wrangler dev` picks up the right contract addresses + secrets without
 * hand-editing files.
 *
 * Usage:
 *   tsx scripts/gen-dev-vars.ts                    # network=anvil
 *   DEPLOY_NETWORK=base-sepolia tsx scripts/gen-dev-vars.ts
 *
 * Generated files:
 *   apps/demo-a2a/.dev.vars
 *   apps/demo-mcp/.dev.vars
 *   apps/demo-edge/.dev.vars       (admission gateway: chain/contracts/origins + the dev gateway-assertion secret)
 *   apps/demo-web-pro/.env.local, apps/demo-web-recovery/.env.local
 *   apps/demo-sso-next/.env.local   (the local Home — broker key, chain, KV, custody bridge)
 *   apps/demo-web/.env.local        (points the relying app at the local Home)
 *
 * All are gitignored — they hold dev-only secrets too.
 *
 * Local-Home knobs (defaults suit `wrangler dev` + `next dev` on one machine):
 *   HOME_ORIGIN       http://localhost:5373   the local demo-sso-next
 *   KV_REST_API_URL   http://127.0.0.1:8079   an Upstash-REST-compatible KV (redis + serverless-redis-http)
 *   KV_REST_API_TOKEN local-dev-token
 *   LOCAL_RPC_URL     http://127.0.0.1:8545
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';

const REPO_ROOT = join(import.meta.dirname ?? __dirname, '..');
const NETWORK = process.env.DEPLOY_NETWORK ?? 'anvil';
const DEPLOYMENTS_PATH = join(REPO_ROOT, 'packages', 'contracts', `deployments-${NETWORK}.json`);
const LOCAL = NETWORK === 'anvil';
const HOME_ORIGIN = process.env.HOME_ORIGIN ?? 'http://localhost:5373';
const LOCAL_RPC_URL = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
const A2A_URL = LOCAL ? 'http://127.0.0.1:8787' : 'https://demo-a2a-production.richardpedersen3.workers.dev';
const MCP_URL = LOCAL ? 'http://127.0.0.1:8788' : 'https://demo-mcp-production.richardpedersen3.workers.dev';
const EDGE_URL = LOCAL ? 'http://127.0.0.1:8789' : 'https://demo-edge-production.richardpedersen3.workers.dev';
/** Browser origins of the local apps that call the workers directly or via proxies. */
const LOCAL_ORIGINS = [
  'http://127.0.0.1:5173', 'http://localhost:5173', // demo-web
  'http://127.0.0.1:5273', 'http://localhost:5273', // demo-web-pro (calls the workers cross-origin)
  HOME_ORIGIN, HOME_ORIGIN.replace('localhost', '127.0.0.1'),
];

if (!existsSync(DEPLOYMENTS_PATH)) {
  console.error(`gen-dev-vars: ${DEPLOYMENTS_PATH} not found.`);
  console.error('Run `pnpm dev:contracts` (or your deploy script) first.');
  process.exit(1);
}

interface Deployments {
  chainId: number;
  entryPoint: string;
  delegationManager: string;
  agentAccountFactory: string;
  timestampEnforcer: string;
  allowedTargetsEnforcer: string;
  allowedMethodsEnforcer: string;
  valueEnforcer: string;
  smartAgentPaymaster?: string;
  universalSignatureValidator?: string;
  custodyPolicy?: string;
  quorumEnforcer?: string;
  approvedHashRegistry?: string;
  deployer?: string;
  // NS/RL/ID Phase 3 stack (live since 2026-05-23).
  ontologyTermRegistry?: string;
  shapeRegistry?: string;
  agentNameRegistry?: string;
  agentNameResolver?: string;
  agentNameUniversalResolver?: string;
  agentRelationship?: string;
  relationshipTypeRegistry?: string;
  agentProfileResolver?: string;
  permissionlessSubregistry?: string;
  paymentEnforcer?: string;
  agentAccountImplementation?: string;
  deploymentEpoch?: string;
}

const d = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8')) as Deployments;

// Spec 311 — same derivation as packages/contracts/scripts/build-deployments.mjs, so a locally
// injected table carries an epoch exactly like the published ones.
if (!d.deploymentEpoch) {
  const authority = ['agentAccountFactory', 'agentAccountImplementation', 'delegationManager', 'universalSignatureValidator']
    .map((k) => String((d as Record<string, unknown>)[k] ?? '').toLowerCase())
    .join('|');
  d.deploymentEpoch = 'ep_' + createHash('sha256').update(`${d.chainId ?? ''}|${authority}`).digest('hex').slice(0, 16);
}

/** Read one KEY=value from an existing dotenv file (to keep a generated secret stable across runs). */
function readDotEnvValue(filePath: string, key: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1);
  }
  return undefined;
}

/** The local Home's ES256 broker key. Generated once, then reused from the existing .env.local so
 *  sessions/id_tokens survive a regen. Dev only — production keys are generated with
 *  apps/demo-sso-next/scripts/gen-broker-key.mjs and stored as a Sensitive Vercel env. */
function localBrokerJwk(envLocalPath: string): string {
  const existing = readDotEnvValue(envLocalPath, 'BROKER_PRIVATE_JWK');
  if (existing && existing.startsWith('{')) return existing;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return JSON.stringify({ ...jwk, alg: 'ES256', use: 'sig', kid: 'broker-local' });
}

// Dev-only secrets. Stable across runs so cookies + AAD-bound encryption
// don't break when wrangler restarts. NEVER use these in production —
// production sets via `wrangler secret put`.
const DEV_SECRETS = {
  SESSION_JWT_SECRETS: 'e2e-kid:' + 'aa'.repeat(32),
  CSRF_SECRET: '0x' + 'bb'.repeat(32),
  A2A_SESSION_SECRET: '0x' + 'cc'.repeat(32),
  // Anvil[0] private key. Public knowledge; safe for dev.
  A2A_MASTER_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  // Audit C1: shared MAC secret used by demo-a2a (caller) AND
  // demo-mcp (verifier) to authenticate the A2A→MCP service envelope.
  // Same 32-byte hex on both .dev.vars files so the HMAC subkeys match.
  A2A_MAC_SECRET: '0x' + 'dd'.repeat(32),
  // SEC-010: the Home → demo-a2a custody bridge secret (/custody/oidc/resolve). Same value in
  // demo-a2a's .dev.vars and the Home's .env.local.
  A2A_CUSTODY_BRIDGE_SECRET: '0x' + 'ff'.repeat(32),
  // spec 288 §4: the edge-minted GatewayAssertion HMAC secret — same value on demo-edge (signer) and
  // demo-a2a / demo-mcp (verifiers). Locally the origins do not REQUIRE the assertion; setting it lets
  // the edge path be exercised end-to-end.
  GATEWAY_ASSERTION_SECRET: '0x' + 'ab'.repeat(32),
};

/** The Home's own client_id — the `aud` of custody-grade sessions demo-a2a's broker gate pins. */
const HOME_AUD = 'demo-sso';

function writeDotEnv(filePath: string, content: Record<string, string>, opts?: { preserveExtra?: boolean }): void {
  const lines = ['# Generated by scripts/gen-dev-vars.ts — DO NOT EDIT BY HAND'];
  lines.push(`# Source: deployments-${NETWORK}.json`);
  lines.push('');
  for (const [k, v] of Object.entries(content)) {
    lines.push(`${k}=${v}`);
  }
  // Keys a developer added by hand (e.g. GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI for
  // real Google sign-in on the local Home) survive a regen instead of being silently dropped.
  if (opts?.preserveExtra && existsSync(filePath)) {
    const extra: string[] = [];
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
      if (m && !(m[1] in content)) extra.push(line);
    }
    if (extra.length) lines.push('', '# Preserved from the previous file (not generated — yours to manage):', ...extra);
  }
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

const a2aVars: Record<string, string> = {
  ...DEV_SECRETS,
  ENTRY_POINT: d.entryPoint,
  DELEGATION_MANAGER: d.delegationManager,
  AGENT_ACCOUNT_FACTORY: d.agentAccountFactory,
  TIMESTAMP_ENFORCER: d.timestampEnforcer,
  ALLOWED_TARGETS_ENFORCER: d.allowedTargetsEnforcer,
  ALLOWED_METHODS_ENFORCER: d.allowedMethodsEnforcer,
  VALUE_ENFORCER: d.valueEnforcer,
  // PAYMASTER: only present when deployments JSON has the address.
  // Without it, demo-a2a's /session/deploy returns 409 and the frontend
  // falls back to counterfactual mode.
  ...(d.smartAgentPaymaster ? { PAYMASTER: d.smartAgentPaymaster } : {}),
  // UNIVERSAL_SIGNATURE_VALIDATOR: only present when deployments JSON
  // has it. Without it, /auth/siwe-verify falls back to ECDSA-only
  // recovery (EOA flow); passkey login will fail.
  ...(d.universalSignatureValidator
    ? { UNIVERSAL_SIGNATURE_VALIDATOR: d.universalSignatureValidator }
    : {}),
  // NS/RL/ID stack + custody/quorum: production sets these in wrangler.toml [vars]; locally they
  // were missing, so /deployments reported `agentNameRegistry: null` and naming was silently off.
  ...(d.agentNameRegistry          ? { AGENT_NAME_REGISTRY:           d.agentNameRegistry          } : {}),
  ...(d.agentNameUniversalResolver ? { AGENT_NAME_UNIVERSAL_RESOLVER: d.agentNameUniversalResolver } : {}),
  ...(d.agentProfileResolver       ? { PROFILE_RESOLVER:              d.agentProfileResolver       } : {}),
  ...(d.permissionlessSubregistry  ? { PERMISSIONLESS_SUBREGISTRY:    d.permissionlessSubregistry  } : {}),
  ...(d.agentRelationship          ? { AGENT_RELATIONSHIP:            d.agentRelationship          } : {}),
  ...(d.custodyPolicy              ? { CUSTODY_POLICY:                d.custodyPolicy              } : {}),
  ...(d.quorumEnforcer             ? { QUORUM_ENFORCER:               d.quorumEnforcer             } : {}),
  ...(d.approvedHashRegistry       ? { APPROVED_HASH_REGISTRY:        d.approvedHashRegistry       } : {}),
  ...(d.paymentEnforcer            ? { PAYMENT_ENFORCER:              d.paymentEnforcer            } : {}),
  // The local Home (demo-sso-next) as the OIDC broker demo-a2a's custody gate trusts (spec 235/294).
  // .dev.vars overrides wrangler.toml [vars], so ALLOWED_ORIGINS also admits the Home's origin (its
  // /a2a/* rewrite forwards the browser Origin).
  ...(LOCAL
    ? {
        BROKER_ISS: HOME_ORIGIN,
        BROKER_JWKS_URL: `${HOME_ORIGIN}/jwks`,
        DEMO_SSO_AUD: HOME_AUD,
        ALLOWED_ORIGINS: LOCAL_ORIGINS.join(','),
        DEMO_EDGE_URL: EDGE_URL,
        // The InteractionsDO's bound-mint session signer (NEW-C1) — a Cloud KMS key in production; locally
        // anvil[9] (public dev key), distinct from the relayer's anvil[0].
        A2A_INTERACTIONS_SESSION_PRIVATE_KEY: '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
      }
    : {}),
};

const mcpVars: Record<string, string> = {
  DELEGATION_MANAGER: d.delegationManager,
  TIMESTAMP_ENFORCER: d.timestampEnforcer,
  ALLOWED_TARGETS_ENFORCER: d.allowedTargetsEnforcer,
  ALLOWED_METHODS_ENFORCER: d.allowedMethodsEnforcer,
  VALUE_ENFORCER: d.valueEnforcer,
  // wrangler.toml [vars] pins the Base Sepolia validator; the local deployment's must win (ERC-1271 /
  // ERC-6492 checks on delegations + vault-key authorizations resolve through it).
  ...(d.universalSignatureValidator ? { UNIVERSAL_SIGNATURE_VALIDATOR: d.universalSignatureValidator } : {}),
  // Audit C1: shared MAC secret matching demo-a2a's value above.
  A2A_MAC_SECRET: DEV_SECRETS.A2A_MAC_SECRET,
  // spec 277 Phase 6: HS256 signing secret for the demo OAuth ingress
  // (authorization endpoint + /mcp bearer validation). Deterministic dev value;
  // production sets a wrangler secret via set-cloudflare-secrets.sh.
  OAUTH_SIGNING_SECRET: '0x' + 'ee'.repeat(32),
  // spec 277 Phase 6: enable the open /oauth/token demo authorization endpoint
  // locally (fail-closed behind this flag). Mirrors wrangler.toml [vars].
  DEMO_OAUTH_MINT_ENABLED: 'true',
  // Dev-only per-person vault KEKs derived locally (no GCP Cloud KMS on a workstation). Refused in
  // production by demo-mcp (vault-key.ts `localKekEnabled`). Never a real deployment value.
  ...(LOCAL ? { DEMO_VAULT_LOCAL_KEK_SECRET: '0x' + '99'.repeat(32) } : {}),
};

// preserveExtra: the AKCS backend lines (A2A_KMS_BACKEND / AKCS_*) are written by the sibling
// faithkms repo (`just demo-stack-init`) and must survive a regen.
writeDotEnv(join(REPO_ROOT, 'apps', 'demo-a2a', '.dev.vars'), a2aVars, { preserveExtra: true });
writeDotEnv(join(REPO_ROOT, 'apps', 'demo-mcp', '.dev.vars'), { ...mcpVars, GATEWAY_ASSERTION_SECRET: DEV_SECRETS.GATEWAY_ASSERTION_SECRET }, { preserveExtra: true });

// The Agentic Edge (spec 288 §6): public-config discovery doc + admission in front of demo-a2a/demo-mcp.
// Its wrangler.toml top-level (dev) block binds MCP/A2A to the sibling `wrangler dev` sessions.
const edgeVars: Record<string, string> = {
  CHAIN_ID: String(d.chainId),
  ENTRY_POINT: d.entryPoint,
  DELEGATION_MANAGER: d.delegationManager,
  ...(d.universalSignatureValidator ? { UNIVERSAL_SIGNATURE_VALIDATOR: d.universalSignatureValidator } : {}),
  SA_BUDGET_LIMIT_UNITS: '50000',
  EDGE_ALLOWED_ORIGINS: LOCAL_ORIGINS.join(','),
  GATEWAY_ASSERTION_SECRET: DEV_SECRETS.GATEWAY_ASSERTION_SECRET,
};
writeDotEnv(join(REPO_ROOT, 'apps', 'demo-edge', '.dev.vars'), edgeVars, { preserveExtra: true });

// demo-web-pro's vite dev server reads .env.local at startup; vars must be
// VITE_-prefixed to be inlined into the bundle. Network-dependent — runs
// against whichever chain the contracts were last deployed to.
const webProVars: Record<string, string> = {
  VITE_CHAIN_ID: String(d.chainId),
  VITE_FACTORY_ADDRESS: d.agentAccountFactory,
  VITE_DELEGATION_MANAGER: d.delegationManager,
  VITE_DEMO_A2A_URL: NETWORK === 'anvil'
    ? 'http://127.0.0.1:8787'
    : 'https://demo-a2a-production.richardpedersen3.workers.dev',
  VITE_DEMO_MCP_URL: NETWORK === 'anvil'
    ? 'http://127.0.0.1:8788'
    : 'https://demo-mcp-production.richardpedersen3.workers.dev',
  // spec 288 — the native MCP panel routes through the Agentic Edge; spec 311 — the authority epoch the
  // client guards its stored sessions with. Both were only set by deploy-cloudflare.ts before.
  VITE_DEMO_EDGE_URL: EDGE_URL,
  ...(d.deploymentEpoch ? { VITE_DEPLOYMENT_EPOCH: d.deploymentEpoch } : {}),
  // The Home origin (demo-sso-next) — demo-web-pro offers its demo people (Alice, Bob) as quick-connect
  // seats when this is set. Locally the Home is at HOME_ORIGIN; unset in prod builds without a Home.
  ...(LOCAL ? { VITE_BROKER_ORIGIN: HOME_ORIGIN } : {}),
  ...(d.custodyPolicy   ? { VITE_CUSTODY_POLICY:    d.custodyPolicy   } : {}),
  ...(d.quorumEnforcer       ? { VITE_QUORUM_ENFORCER:        d.quorumEnforcer       } : {}),
  ...(d.approvedHashRegistry ? { VITE_APPROVED_HASH_REGISTRY: d.approvedHashRegistry } : {}),
  ...(d.entryPoint           ? { VITE_ENTRY_POINT:             d.entryPoint           } : {}),
  ...(d.smartAgentPaymaster  ? { VITE_SMART_AGENT_PAYMASTER:   d.smartAgentPaymaster  } : {}),
  ...(d.deployer             ? { VITE_DEPLOYER:                d.deployer             } : {}),
  ...(d.timestampEnforcer       ? { VITE_TIMESTAMP_ENFORCER:        d.timestampEnforcer       } : {}),
  ...(d.valueEnforcer           ? { VITE_VALUE_ENFORCER:            d.valueEnforcer           } : {}),
  ...(d.allowedTargetsEnforcer  ? { VITE_ALLOWED_TARGETS_ENFORCER:  d.allowedTargetsEnforcer  } : {}),
  ...(d.allowedMethodsEnforcer  ? { VITE_ALLOWED_METHODS_ENFORCER:  d.allowedMethodsEnforcer  } : {}),
  // NS/RL/ID Phase 3 stack — naming + relationships + identity profile
  // contracts. Surface to demo so the read-side hooks can construct
  // their clients without bundling the deployments JSON.
  ...(d.agentNameRegistry          ? { VITE_AGENT_NAME_REGISTRY:           d.agentNameRegistry          } : {}),
  ...(d.agentNameResolver          ? { VITE_AGENT_NAME_RESOLVER:           d.agentNameResolver          } : {}),
  ...(d.agentNameUniversalResolver ? { VITE_AGENT_NAME_UNIVERSAL_RESOLVER: d.agentNameUniversalResolver } : {}),
  ...(d.agentRelationship          ? { VITE_AGENT_RELATIONSHIP:            d.agentRelationship          } : {}),
  ...(d.relationshipTypeRegistry   ? { VITE_RELATIONSHIP_TYPE_REGISTRY:    d.relationshipTypeRegistry   } : {}),
  ...(d.agentProfileResolver       ? { VITE_AGENT_PROFILE_RESOLVER:        d.agentProfileResolver       } : {}),
  ...(d.ontologyTermRegistry       ? { VITE_ONTOLOGY_TERM_REGISTRY:        d.ontologyTermRegistry       } : {}),
  ...(d.shapeRegistry              ? { VITE_SHAPE_REGISTRY:                d.shapeRegistry              } : {}),
  ...(d.permissionlessSubregistry  ? { VITE_PERMISSIONLESS_SUBREGISTRY:    d.permissionlessSubregistry  } : {}),
  // Use the same RPC the workers use so reads stay in sync with writes
  // (avoids the "schedule succeeded but the read RPC doesn't see it yet"
  // class of bug that mis-signs apply hashes as eta=0).
  ...(process.env.BASE_SEPOLIA_RPC && NETWORK === 'base-sepolia'
    ? { VITE_RPC_URL: process.env.BASE_SEPOLIA_RPC }
    : {}),
};
writeDotEnv(join(REPO_ROOT, 'apps', 'demo-web-pro', '.env.local'), webProVars);
// Recovery demo uses the exact same env shape as demo-web-pro — same
// chain, same contracts, same workers; the apps differ only in story.
writeDotEnv(join(REPO_ROOT, 'apps', 'demo-web-recovery', '.env.local'), webProVars);

// The local Home (apps/demo-sso-next) + the relying app that connects to it (apps/demo-web). Only for
// a local network: against base-sepolia the deployed Home at impact-agent.me is the Home.
if (LOCAL) {
  const homeEnvPath = join(REPO_ROOT, 'apps', 'demo-sso-next', '.env.local');
  const homeVars: Record<string, string> = {
    BROKER_PRIVATE_JWK: localBrokerJwk(homeEnvPath),
    BROKER_KID: 'broker-local',
    DEMO_SSO_AUD: HOME_AUD,
    // Chain + contracts (src/lib/chain.ts): the local deployment table is injected, not imported.
    NEXT_PUBLIC_CHAIN_ID: String(d.chainId),
    NEXT_PUBLIC_RPC_URL: LOCAL_RPC_URL,
    RPC_URL: LOCAL_RPC_URL,
    NEXT_PUBLIC_CONTRACTS_JSON: JSON.stringify(d),
    // Workers (next.config.mjs rewrites /a2a/* → DEMO_A2A_URL, /a2a/mcp/* → DEMO_EDGE_URL, /mcp-bind/* → DEMO_MCP_URL).
    DEMO_A2A_URL: A2A_URL,
    DEMO_MCP_URL: MCP_URL,
    DEMO_EDGE_URL: EDGE_URL,
    A2A_CUSTODY_URL: A2A_URL,
    A2A_VAULT_URL: A2A_URL,
    A2A_CUSTODY_BRIDGE_SECRET: DEV_SECRETS.A2A_CUSTODY_BRIDGE_SECRET,
    // Upstash-REST-compatible KV (app/_lib/kv.ts). Locally: redis + hiett/serverless-redis-http.
    KV_REST_API_URL: process.env.KV_REST_API_URL ?? 'http://127.0.0.1:8079',
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN ?? 'local-dev-token',
    // Echo OTPs to the response instead of sending email/SMS (no SendGrid/Twilio locally).
    DEV_OTP_ECHO: '1',
  };
  // The demo people (Alice, Nathan, …) as quick-connect identities, once
  // apps/demo-sso-next/scripts/provision-demo-personas-local.ts has deployed their Smart Agents on this chain. Their
  // custodian keys are the roster's public demo keys; DEMO_SIGNER_SECRET gates the server-to-server
  // signer (/connect/demo-sign, /connect/demo-provision) for local demo apps.
  const localRoster = join(REPO_ROOT, 'demo', 'personas.local.json');
  if (existsSync(localRoster)) {
    const roster = JSON.parse(readFileSync(localRoster, 'utf8')) as Record<string, { chainId?: number }>;
    homeVars.DEMO_PERSONA_KEYS = JSON.stringify(roster);
    homeVars.DEMO_SIGNER_SECRET = 'local-demo-signer-' + 'ab'.repeat(16);
  } else {
    console.warn('gen-dev-vars: demo/personas.local.json missing — quick-connect (demo personas) stays off. Run: pnpm --filter @agenticprimitives-demo/sso-next exec tsx scripts/provision-demo-personas-local.ts');
  }
  writeDotEnv(homeEnvPath, homeVars, { preserveExtra: true });

  writeDotEnv(join(REPO_ROOT, 'apps', 'demo-web', '.env.local'), {
    VITE_CHAIN_ID: String(d.chainId),
    VITE_BROKER_ORIGIN: HOME_ORIGIN,
    VITE_SOCIAL_AUD: 'demo-web',
    ...(d.agentNameRegistry          ? { VITE_AGENT_NAME_REGISTRY:           d.agentNameRegistry          } : {}),
    ...(d.agentNameUniversalResolver ? { VITE_AGENT_NAME_UNIVERSAL_RESOLVER: d.agentNameUniversalResolver } : {}),
  });
}

console.log(`gen-dev-vars: wrote .dev.vars + .env.local (network=${NETWORK}${LOCAL ? `, home=${HOME_ORIGIN}` : ''})`);
console.log(`  factory: ${d.agentAccountFactory}`);
console.log(`  delegationManager: ${d.delegationManager}`);
if (d.custodyPolicy) console.log(`  custodyPolicy: ${d.custodyPolicy}`);
