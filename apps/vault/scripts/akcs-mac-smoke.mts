/**
 * akcs-mac-smoke.mts — a2a→mcp service-MAC through AKCS (`agentic-kms`), end to end.
 *
 * Produces a MAC as demo-a2a would (mcp-runtime `generateServiceMac` + the `agentic-kms` MAC provider
 * using demo-a2a's AKCS token) and posts it to a running demo-mcp (`/tools/get_profile`), which must
 * recompute the same MAC through AKCS with ITS token. A `service-mac rejected` 401 = mismatch.
 *
 *   pnpm --filter @agenticprimitives-demo/mcp exec tsx scripts/akcs-mac-smoke.mts [http://127.0.0.1:8788]
 */
import { readFileSync } from 'node:fs';
import { buildMacProvider, loadSecret, staticTokenProvider } from '@agenticprimitives/key-custody';
import { bodyDigestHex, generateServiceMac } from '@agenticprimitives/mcp-runtime';

const read = (p: string) => Object.fromEntries(readFileSync(new URL(p, import.meta.url), 'utf8').split('\n').filter((l) => /^[A-Z]/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const a2a = read('../../demo-a2a/.dev.vars');
const mcp = read('../.dev.vars');
const base = process.argv[2] ?? 'http://127.0.0.1:8788';
process.env.NODE_ENV = 'development';
const audience = 'urn:mcp:server:person';
const provider = buildMacProvider(audience, {
  backend: 'agentic-kms',
  agenticKms: { baseUrl: a2a.AKCS_BASE_URL!, tenantId: a2a.AKCS_TENANT_ID!, tokenProvider: staticTokenProvider(loadSecret(a2a.AKCS_TOKEN!)), acceptedProtectionLevels: ['DEV_LOCAL'] },
});
const body = JSON.stringify({ address: '0x000000000000000000000000000000000000abcd' });
const ctx = { audience, service: 'a2a-to-mcp', route: 'get_profile', bodyDigest: bodyDigestHex(body) };
const h = await generateServiceMac({ ctx, provider });
const res = await fetch(`${base}/tools/get_profile`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'X-A2A-Mac': h.mac, 'X-A2A-Mac-Nonce': h.nonce, 'X-A2A-Mac-Timestamp': h.timestamp, 'X-A2A-Mac-Key-Id': h.keyId },
  body,
});
const text = await res.text();
const rejected = res.status === 401 && text.includes('service-mac');
console.log(`demo-mcp ${res.status}: ${text.slice(0, 160)}`);
console.log(rejected ? 'MAC SMOKE FAILED — service-mac rejected (demo-mcp did not recompute the same MAC via AKCS)' : `MAC SMOKE OK — service-mac accepted via AKCS (keyId ${h.keyId}; mcp backend=${mcp.A2A_KMS_BACKEND})`);
process.exit(rejected ? 1 : 0);
