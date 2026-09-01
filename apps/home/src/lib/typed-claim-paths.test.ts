/**
 * Every name-claiming path carries the typed suffix to the server.
 *
 * The KMS/social paths (Google · YouVersion · email · phone) resolve the name and then POST to
 * demo-a2a. They used to omit the suffix entirely, so `node` was the namehash under the LEGACY root and
 * the worker registered there — the org form promised ".org" and produced `<label>.impact`
 * (2026-08-31). A phone-session member hit this; the device-credential paths were already correct,
 * which is precisely why it survived: the bug only appears for one custody family.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'connect-client.ts'), 'utf8');

/** The body of one `async function <name>(` / `export async function <name>(` declaration. */
function fn(name: string): string {
  const i = SRC.indexOf(`async function ${name}(`);
  expect(i, `${name} not found`).toBeGreaterThan(-1);
  const next = SRC.indexOf('\nasync function ', i + 1);
  const nextExport = SRC.indexOf('\nexport async function ', i + 1);
  const end = Math.min(...[next, nextExport].filter((n) => n > -1));
  return SRC.slice(i, end > 0 ? end : i + 6000);
}

describe('typed suffix reaches the server on every social claim path', () => {
  it('resolveExactName takes a tld and forwards it', () => {
    const f = fn('resolveExactName');
    expect(f).toContain('tld?: string');
    expect(f).toContain('&tld=${encodeURIComponent(tld)}');
    // The "taken" message used to hardcode `.impact`, mislabelling a typed collision.
    expect(f).not.toContain('.impact” is already taken');
  });

  it('createManagedAgentSocial resolves and sends the kind’s suffix', () => {
    const f = fn('createManagedAgentSocial');
    expect(f).toContain('typedTldForKind(input.kind)');
    expect(f).toContain('resolveExactName(input.label!, typed?.tld)');
    expect(f).toContain('tld: typed?.tld');
  });

  it('nameManagedAgentSocial resolves and sends the kind’s suffix', () => {
    const f = fn('nameManagedAgentSocial');
    expect(f).toContain('typedTldForKind(input.kind)');
    expect(f).toContain('resolveExactName(input.label, typed?.tld)');
    expect(f).toContain('tld: typed?.tld');
  });

  it('secureHomeWithGoogle claims the PERSON root', () => {
    const f = fn('secureHomeWithGoogle');
    expect(f).toContain('personClaimRoot()');
    expect(f).toContain('tld: typed.tld');
  });

  it('createOrganizationWithGoogle claims the ORG root', () => {
    const f = fn('createOrganizationWithGoogle');
    expect(f).toContain("typedTldForKind('org')");
    expect(f).toContain('tld: typed?.tld');
  });

  it('no social path fetches /connect/name without a suffix', () => {
    // A bare `?base=` or `?exact=1&label=` query resolves under the legacy root by definition.
    const bare = [...SRC.matchAll(/`\/connect\/name\?[^`]*`/g)].map((m) => m[0]);
    expect(bare.length).toBeGreaterThan(0);
    for (const q of bare) expect(q, `${q} resolves under the legacy root`).toContain('tld');
  });
});
