/**
 * A name asked of the naming service must not be rewritten into a different name.
 *
 * `/connect/name-info` and `/connect/with-name` each carried their own copy of
 *
 *     n.endsWith('.impact') ? n : `${n}.impact`
 *
 * which appended the legacy parent to anything not already ending in it. A typed name became
 * `phone-6115.me.impact` — a name that exists nowhere — so `resolveName` returned null and the home's
 * own subdomain answered "No home named phone-6115 yet" while the chain held `phone-6115.me` with the
 * primary name set. Sign-in by any typed name was broken the same way, since with-name resolves the
 * agent from the name before checking the credential (2026-09-01).
 *
 * The chain was never wrong here. Only the string handed to it was.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { qualifiedAgentName } from './domain';
import { AGENT_NAME_PARENT } from './domain';

describe('qualifiedAgentName', () => {
  it('leaves a typed name exactly as given', () => {
    expect(qualifiedAgentName('phone-6115.me')).toBe('phone-6115.me');
    expect(qualifiedAgentName('vault.svc')).toBe('vault.svc');
  });

  it('leaves a legacy name as given', () => {
    // `.impact` and `.demo.agent` parse as `legacy`, NOT `canonical` — a check for canonical alone
    // would have sent every legacy name back down the append path.
    expect(qualifiedAgentName('phone-6115.impact')).toBe('phone-6115.impact');
    expect(qualifiedAgentName('foo.demo.agent')).toBe('foo.demo.agent');
  });

  it('qualifies a BARE label with this deployment’s parent', () => {
    expect(qualifiedAgentName('phone-6115')).toBe(`phone-6115.${AGENT_NAME_PARENT}`);
  });

  it('normalizes case and trailing dots without changing the name', () => {
    expect(qualifiedAgentName('  Phone-6115.ME  ')).toBe('phone-6115.me');
    expect(qualifiedAgentName('phone-6115.me.')).toBe('phone-6115.me');
  });

  it('never appends to a dotted string it cannot parse — it does not invent a third name', () => {
    // `x.org` is rejected (label too short). Appending would ask the chain for `x.org.impact`, which is
    // the exact failure mode being removed. Returning it unchanged resolves to nothing, honestly.
    expect(qualifiedAgentName('x.org')).toBe('x.org');
    expect(qualifiedAgentName('weird.zzz')).toBe('weird.zzz');
  });

  it('is empty for empty input rather than a bare parent', () => {
    expect(qualifiedAgentName('')).toBe('');
    expect(qualifiedAgentName('   ')).toBe('');
  });
});

describe('both lookup routes use the shared rule', () => {
  for (const route of ['name-info.ts', 'with-name.ts']) {
    it(`${route} no longer hardcodes the legacy parent`, () => {
      const src = readFileSync(join(__dirname, '..', '..', 'server', 'connect', route), 'utf8');
      expect(src).toContain('qualifiedAgentName as fullName');
      expect(src).not.toMatch(/endsWith\('\.impact'\)/);
    });
  }
});
