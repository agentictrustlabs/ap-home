// THE RUNTIME'S DEPLOY PREFLIGHT (scripts/deploy.mts): this runtime reads every owner's Library index through the vault's
// catalog door, so it refuses to deploy against a vault whose /health does not name it.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CATALOG_DOOR, envOf, mcpUrlOf, vaultPreflight } from '../scripts/deploy.mjs';
import { CATALOG_PAGED_FORMAT } from '../src/catalog-pages.js';

const health = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('the vault preflight', () => {
  it('names the format the runtime speaks', () => expect(CATALOG_DOOR).toBe(CATALOG_PAGED_FORMAT));

  it('passes only a vault whose /health names the catalog door', async () => {
    expect(await vaultPreflight('https://mcp.test', health({ ok: true, catalogDoor: CATALOG_DOOR }))).toBeNull();
    expect(await vaultPreflight('https://mcp.test', health({ ok: true, service: 'demo-mcp' }))).toMatch(/deploy apps\/vault first/);
    expect(await vaultPreflight('https://mcp.test', health({}, 503))).toMatch(/503/);
    expect(await vaultPreflight('https://mcp.test', (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch)).toMatch(/did not answer/);
  });

  it("reads the environment's vault from wrangler.toml", () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    expect(envOf(['--env', 'faithnet'])).toBe('faithnet');
    expect(envOf(['--env=faithnet', '--dry-run'])).toBe('faithnet');
    expect(envOf(['--dry-run'])).toBeNull();
    expect(mcpUrlOf(toml, 'faithnet')).toBe('https://mcp.faithnet.io');
    expect(mcpUrlOf(toml, null)).toMatch(/^http/);
  });
});

