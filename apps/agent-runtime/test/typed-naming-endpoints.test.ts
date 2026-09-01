/**
 * Every KMS-custodied naming endpoint names under the suffix it was ASKED for.
 *
 * The four `/custody/oidc/*` naming endpoints were pinned to `PERMISSIONLESS_SUBREGISTRY` — the legacy
 * untyped root — long after their callers moved to typed suffixes (spec 346). The Home's org form
 * offered ".org", the member typed a name, and the agent came back `<label>.impact`: a suffix that
 * declares no type, so the agent is unlistable and fails closed at the registry (2026-08-31).
 *
 * These are source-shape assertions on purpose. The wiring is one argument inside a long handler, which
 * is exactly the kind of line that gets copied into a fifth endpoint with the old constant still in it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

/** The body of one `app.post('<path>', …)` handler, up to the next route registration. */
function handler(path: string): string {
  const start = SRC.indexOf(`app.post('${path}'`);
  expect(start, `${path} handler not found`).toBeGreaterThan(-1);
  const next = SRC.indexOf("\napp.post('", start + 1);
  const nextGet = SRC.indexOf("\napp.get('", start + 1);
  const end = Math.min(...[next, nextGet].filter((n) => n > -1));
  return SRC.slice(start, end > 0 ? end : undefined);
}

const NAMING_ENDPOINTS = [
  '/custody/oidc/bootstrap-and-claim',
  '/custody/oidc/bootstrap-org',
  '/custody/oidc/bootstrap-agent',
  '/custody/oidc/name-agent',
] as const;

describe('typed naming on the KMS-custodied endpoints', () => {
  for (const path of NAMING_ENDPOINTS) {
    describe(path, () => {
      const h = handler(path);

      it('resolves the root from the requested suffix, not the legacy constant', () => {
        expect(h).toContain('subregistryForTld(c.env, body.tld)');
        expect(h).not.toContain('subregistry: c.env.PERMISSIONLESS_SUBREGISTRY');
      });

      it('accepts a tld on the request body', () => {
        expect(h).toMatch(/tld\?: string/);
      });

      it('declares the agent type in the same batch as a typed claim', () => {
        expect(h).toContain('declareTypeCallsFor(c.env');
        expect(h).toContain('root.typed');
      });

      it('reports the name under the suffix it actually claimed', () => {
        // The old handlers interpolated AGENT_NAME_PARENT into the response, so a typed claim was
        // reported back as `<label>.impact` even when it had landed elsewhere.
        expect(h).not.toMatch(/name: `\$\{[^}]*\}\.\$\{AGENT_NAME_PARENT\}`/);
      });
    });
  }

  it('fails closed on a suffix this deployment cannot serve — never the legacy root quietly', () => {
    const fn = SRC.slice(SRC.indexOf('function subregistryForTld'), SRC.indexOf('function declareTypeCallsFor'));
    expect(fn).toContain('suffix_not_claimable');
    expect(fn).toContain('unknown_suffix');
    // The legacy root is reachable ONLY when no suffix was requested (or the legacy one was).
    expect(fn).toMatch(/if \(!raw \|\| raw === parent\)/);
  });

  it('sizes the call gas on the one naming endpoint that is a CALL, not a deploy', () => {
    // Deploys default to 2.5M; buildCallUserOp defaults to 800k, which a typed claim exceeds.
    expect(handler('/custody/oidc/name-agent')).toContain('sizeCallGas(c.env, body.agent, callData)');
  });
});
