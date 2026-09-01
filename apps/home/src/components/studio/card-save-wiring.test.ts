/**
 * Saving a card must also point the NAME at it.
 *
 * "I saved the agent card thinking it would set the naming service A2A endpoint … but it did not."
 * `adoptEndpointIfUnset` was defined, correct, and CALLED BY NOTHING: a later rewrite of the publish
 * step replaced the block it lived in and dropped the one line that invoked it. TypeScript is silent
 * about an unused `useCallback` — it is a value that is assigned — so nothing failed. The behaviour just
 * stopped, and the only way to notice was to save a card and go look at the name.
 *
 * A behavioural test would need the whole Studio; what is actually worth pinning is the WIRING, so this
 * reads the source. It is the same guard the channels steward-proof uses, for the same reason: a
 * convention that lives in one line inside a long function is one refactor away from being gone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/components/studio/AgentCardFlow.tsx'), 'utf8');

/** The body of the `if (step === 'publish') { … }` branch in the save chain. */
function publishBranch(): string {
  const at = SRC.indexOf("if (step === 'publish')");
  expect(at).toBeGreaterThan(-1);
  return SRC.slice(at, SRC.indexOf('continue;', at));
}

describe('the save chain points the name at the card', () => {
  it('defines the endpoint adoption', () => {
    expect(SRC).toContain('const adoptEndpointIfUnset');
  });

  it('CALLS it, in the publish step — the line that went missing', () => {
    expect(publishBranch()).toContain('adoptEndpointIfUnset()');
  });

  it('awaits it, so a save that reports success has finished writing the name', () => {
    expect(publishBranch()).toMatch(/await\s+adoptEndpointIfUnset\(\)/);
  });

  it('never overwrites an endpoint someone chose', () => {
    // A deliberate endpoint — a proxy, another host — is a decision. Saving a card is not the moment to
    // reverse it, so adoption is strictly "when unset".
    const fn = SRC.slice(SRC.indexOf('const adoptEndpointIfUnset'), SRC.indexOf('const runPublish'));
    expect(fn).toContain('already set — never overwrite');
    expect(fn).toMatch(/if \(\(records\.a2aEndpoint \?\? ''\)\.trim\(\)\) return;/);
  });
});
