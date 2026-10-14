// THE ESTATE'S SHAPE — spec 441. One estate, one configuration, stamped a hundred times.
//
// Spec 436 says what an estate IS. Nothing said what an estate is CONFIGURED like, so the two we run drifted apart
// by accident: 30 of 86 runtime vars differed, one estate kept two raw private keys in Worker secrets and the other
// did not, and the one holding keys in the KMS was the one not declaring which protection levels it accepts back.
// This module is the answer to "what should this estate's deployment look like", and it is the ONLY place the
// derived settings exist. `check-estate-shape.mts` compares it to what is deployed.
//
// Every estate setting is exactly one of three kinds (441 D2). A setting that is none of them is a bug in the spec:
//
//   input    — what a human says. FIVE, and the builder asks for nothing else.
//   derived  — computed here from the inputs. Never typed twice, never edited in wrangler.toml.
//   extra    — product or town. Declared per estate under `extras`, absent by default, never required.
//
// plus TOWN_BASELINE: the settings that belong to the TOWN an estate stands in (its chain's contracts, its shared
// services, the harness defaults it runs). Identical across every estate of the same town, which is why a
// difference between two estates of one town is drift rather than a choice.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type EstateDeclaration = {
  id: string;
  homeHost: string;
  zone: string;
  town: string;
  kmsTenant?: string;
  altZones?: string[];
  extraOrigins?: string[];
  agents?: { harness?: string; interactions?: string };
  extras?: Record<string, string>;
};

export const ESTATES_DIR = 'estates';

export const readDeclarations = (dir = ESTATES_DIR): EstateDeclaration[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.estate.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as EstateDeclaration)
    .sort((a, b) => a.id.localeCompare(b.id));

/** The localhost origins every estate's Home admits in development. Part of the shape, not a per-estate taste. */
const DEV_ORIGINS = ['http://localhost:5175', 'http://127.0.0.1:5175', 'http://localhost:8795'];

/**
 * THE DERIVED SETTINGS (441 D2). Ten vars from five inputs. Each one was typed by hand per estate before this
 * existed, which is how `BROKER_ISS` and `MCP_URL` could ever have disagreed with the host the passkeys are bound
 * to. `agents.*` are OUTPUTS of the build — the estate charters its own and the builder writes them back — so they
 * are derived from the declaration, not from the inputs.
 */
export const deriveVars = (d: EstateDeclaration): Record<string, string> => {
  const home = `https://${d.homeHost}`;
  const apex = d.homeHost.replace(/^www\./, '');
  const zones = [...(d.altZones ?? []), d.zone];
  const origins = [home, `https://${apex}`, `https://*.${apex}`, ...(d.extraOrigins ?? []), ...DEV_ORIGINS];
  const vars: Record<string, string> = {
    ESTATE_ID: d.id,
    AKCS_TENANT_ID: d.kmsTenant ?? d.id,
    BROKER_ISS: home,
    BROKER_JWKS_URL: `${home}/jwks`,
    MCP_URL: `https://mcp.${d.zone}`,
    DEMO_EDGE_URL: `https://edge.${d.zone}`,
    A2A_PUBLIC_BASE_DOMAIN: zones.join(','),
    ALLOWED_ORIGINS: [...new Set(origins)].join(','),
  };
  if (d.agents?.harness) vars.HARNESS_AGENT_SA = d.agents.harness;
  if (d.agents?.interactions) vars.INTERACTIONS_SERVICE_SA = d.agents.interactions;
  return vars;
};

/**
 * THE POSTURE (441 D3/D4). Identical on every estate, and the half of the shape that is a security claim rather
 * than a convenience. Each entry says WHY, because a flag whose reason is unwritten is a flag the next estate
 * copies wrongly.
 */
export const POSTURE: Record<string, { value: string; why: string }> = {
  A2A_KMS_BACKEND: {
    value: 'agentic-kms',
    why: 'the vault\'s per-person KEKs come from the estate\'s own tenant; a local KEK cannot work in a deployed Worker',
  },
  A2A_CUSTODY_KMS_BACKEND: {
    value: 'local-aes',
    why: '441 D4 — custody derivation stays local on EVERY estate. Moving it into the tenant would make the KMS operator a custodian of every resident of every estate (ap-federation 440 §A4), a cost no estate has agreed to pay',
  },
  A2A_RELAYER_KMS_BACKEND: {
    value: 'agentic-kms',
    why: '441 D3 — the relayer\'s key is an AKCS key id, never a Worker secret. A Worker secret is readable by anyone who can deploy that Worker',
  },
  AKCS_ACCEPTED_PROTECTION_LEVELS: {
    value: 'CVM_WRAPPED,CVM_DERIVED',
    why: 'the estate states which protection levels it will accept back, so an AZURE_HSM_DIRECT key cannot be handed to it silently. Unset is not a default, it is an estate that never said',
  },
  DEMO_REQUIRE_GATEWAY_ASSERTION: {
    value: 'true',
    why: 'an estate requires the edge\'s assertion; false admits a request that reached the runtime by another route',
  },
  A2A_ALLOW_LOCAL_MASTER_KEY: {
    value: 'true',
    // W1 wrote `false` here first, reasoning that with the relayer and the interactions key in the KMS nothing
    // local is left to sign. That was wrong, and the gate caught it before anything was deployed: custody IS
    // local on every estate (D4), key-custody's LocalSecp256k1Signer refuses NODE_ENV=production unless this
    // flag says otherwise, so `false` would have broken custody on both estates. This is the flag D4 pays for.
    why: '441 D4 — custody derivation is local on every estate, and a local signer refuses production unless this says so. It is the cost of D4 made visible, and the day custody moves into the tenant this flag goes with it',
  },
};

/**
 * THE KEYS AN ESTATE POINTS AT RATHER THAN HOLDS (441 D3). Required, per-estate values (each estate's own keys in
 * its own tenant), which is why the shape checks for PRESENCE and never for a value.
 */
export const REQUIRED_KEY_IDS = ['AKCS_RELAY_KEY_ID', 'AKCS_INTERACTIONS_KEY_ID'] as const;

/**
 * THE SECRETS NO ESTATE MAY HOLD (441 D3). Not "discouraged": a raw private key in a Worker secret is the one
 * divergence between our two estates where one side is simply worse, and the gate names it by name.
 */
export const FORBIDDEN_SECRETS: Record<string, string> = {
  A2A_MASTER_PRIVATE_KEY: 'the relayer\'s key belongs in the estate\'s tenant as AKCS_RELAY_KEY_ID',
  A2A_INTERACTIONS_SESSION_PRIVATE_KEY: 'the interactions session key belongs in the tenant as AKCS_INTERACTIONS_KEY_ID',
};

/** The secrets every estate must hold, by NAME only — the gate never reads a secret's value. */
export const REQUIRED_SECRETS = [
  'A2A_CUSTODY_BRIDGE_SECRET',
  'A2A_CUSTODY_ROOT_KEY',
  'A2A_INTERNAL_MARKER',
  'A2A_MAC_SECRET',
  'A2A_SESSION_SECRET',
  'AKCS_TOKEN',
  'CSRF_SECRET',
  'GATEWAY_ASSERTION_SECRET',
  'GEMINI_API_KEY',
  'INFERENCE_APP_KEY',
  'RPC_URL',
  'SESSION_JWT_SECRETS',
  'TOWN_HEARTBEAT_TOKEN',
] as const;

/**
 * The town's baseline: a var that is the TOWN's, so two estates of one town must agree on it. Listed as prefixes
 * and exact names rather than enumerated addresses, so adding a contract to the town does not edit this file.
 */
// ORCHESTRATION_* is deliberately NOT here: which model providers and models an estate pays for is a product
// choice (an extra), not something two estates of one town must agree on. Only the harness's routing SWITCHES
// are the town's, and those are named exactly below.
const TOWN_PREFIXES = ['AGENT_', 'ALLOWED_METHODS_', 'ALLOWED_TARGETS_', 'SKILL_', 'PLAN_', 'ASSISTANT_'];
const TOWN_EXACT = new Set([
  'ADOPTED_ONTOLOGY_MANIFEST_DIGEST', 'AKCS_BASE_URL', 'ANSWER_STREAM_DEFAULT', 'APPROVED_HASH_REGISTRY',
  'AP_RUNTIME_AGENT', 'ARD_REGISTRY_ORIGIN', 'CHAIN_ID', 'COMPOSER_MAX_TOKENS', 'CONTRACTS_GENERATION',
  'CUSTODY_POLICY', 'DELEGATION_MANAGER', 'DEMO_SSO_AUD', 'DIGEST_BINDING_ENFORCER', 'ENTRY_POINT',
  'FEDERATION_DOORS', 'INFERENCE_URL', 'KB_RETRIEVAL', 'MOCK_USDC', 'ONTOLOGY_TERM_REGISTRY',
  'OPS_RECORDS_DEFAULT', 'PAYMASTER', 'PAYMASTER_VERIFYING_SIGNER', 'PAYMENT_ENFORCER',
  'PERMISSIONLESS_SUBREGISTRIES', 'PERMISSIONLESS_SUBREGISTRY', 'PRICED_SUBREGISTRIES', 'PROFILE_RESOLVER',
  'PUBLIC_GRAPH_URL', 'QUORUM_ENFORCER', 'RECEIPT_ANCHOR_REGISTRY', 'RESOLVE_CONTEXT_DEFAULT',
  'SA_BUDGET_LIMIT_UNITS', 'TIMESTAMP_ENFORCER', 'UNIVERSAL_SIGNATURE_VALIDATOR', 'VALUE_ENFORCER',
  'A2A_SERVES_UNPUBLISHED_NAMES', 'ORCHESTRATION_GATEWAY', 'ORCHESTRATION_ROUTE',
]);

export const isTownBaseline = (k: string): boolean =>
  TOWN_EXACT.has(k) || TOWN_PREFIXES.some((p) => k.startsWith(p) && !(k in POSTURE) && !k.startsWith('AKCS_'));

/**
 * Read one env's `vars` out of a wrangler.toml. A purpose-built scan rather than a TOML dependency: we need exactly
 * the `[env.<name>.vars]` tables, and adding a parser to this repo changes every other developer's install.
 */
export const wranglerVars = (tomlPath: string, env: string): Record<string, string> => {
  const out: Record<string, string> = {};
  let inside = false;
  for (const line of readFileSync(tomlPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith('[')) { inside = t === `[env.${env}.vars]`; continue; }
    if (!inside || !t || t.startsWith('#')) continue;
    const m = /^([A-Z_0-9]+)\s*=\s*(.+)$/.exec(t);
    if (!m) continue;
    // strip a trailing comment, then the quotes TOML requires around a string
    const raw = m[2].replace(/\s+#.*$/, '').trim();
    out[m[1]] = /^(".*"|'.*')$/.test(raw) ? raw.slice(1, -1) : raw;
  }
  return out;
};

/** A set comparison that does not care which order a comma list was written in. */
export const sameList = (a: string, b: string): boolean => {
  const n = (s: string) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))].sort().join(',');
  return n(a) === n(b);
};
