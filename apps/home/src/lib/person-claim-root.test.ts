/**
 * A person's name is claimed under the PERSON root.
 *
 * `claimName` took the typed root as an optional last parameter defaulting to `{}` — no root, i.e. the
 * legacy parent. Four call sites; three had forgotten it. So a person named through onboarding, or
 * through the required-name gate, was claimed as `<label>.impact` while the one screen that remembered
 * produced `<label>.me`.
 *
 * The failure is silent in the worst way: the claim SUCCEEDS. The name works, resolves, and looks right.
 * What is missing is the derived type a typed root carries (spec 346), and that only surfaces much later,
 * somewhere else, as "declare its type before projecting" when the person tries to list the agent.
 *
 * The fix was to make the default correct rather than to fix three call sites, so the next caller cannot
 * forget. This pins the default itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/connect-client.ts'), 'utf8');

describe('claimName defaults to the person root', () => {
  it('its `typed` parameter is not an empty default', () => {
    const sig = SRC.slice(SRC.indexOf('export async function claimName'), SRC.indexOf('): Promise<{ ok: true; name: string }'));
    expect(sig).toContain('typed: TypedClaimOpts = personClaimRoot()');
    expect(sig).not.toContain('typed: TypedClaimOpts = {}');
  });

  it('the default is deployment-gated, not a hardcoded ".me"', () => {
    // A deployment without the typed roots must still claim under its legacy parent rather than a root
    // that does not exist on its chain.
    const fn = SRC.slice(SRC.indexOf('function personClaimRoot'), SRC.indexOf('export async function claimName'));
    expect(fn).toContain("CLAIMABLE_TLDS.includes('me')");
    expect(fn).toContain('{ tld: \'me\' }');
  });

  it('a managed agent still passes its OWN root — the default is for persons', () => {
    // `buildClaimCallData` is the managed-agent path and is handed `typedTldForKind(kind)`.
    expect(SRC).toContain('typedTldForKind(input.kind) ?? {}');
  });
});
