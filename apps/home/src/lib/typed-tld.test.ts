/**
 * Every kind a person can CREATE lands on a typed root.
 *
 * The create form showed an untyped legacy root while the claim underneath already used the typed
 * one for the kind. So "New organization" promised one suffix and produced `phone-6111.org`.
 * Worse than a cosmetic mismatch: the suffix names the derived TYPE (spec 346), and a legacy root carries
 * NONE — so the form was advertising the one property that would later stop the agent being listed.
 *
 * The display now derives from the kind. This pins the mapping behind it, so a kind added without a typed
 * root fails here rather than quietly falling back to a rootless name.
 */
import { describe, it, expect } from 'vitest';
import { typedTldForKind, tldOfKind } from '../connect-client';
import { CLAIMABLE_TLDS } from './domain';

/** The kinds the Stewardship surfaces actually create today. */
const CREATABLE = [
  ['org', 'org'],
  ['person-treasury', 'treasury'],
  ['org-treasury', 'treasury'],
  ['workspace', 'workspace'],
  ['team', 'team'],
  ['church', 'church'],
  ['circle', 'circle'],
  ['person', 'me'],
] as const;

describe('a created agent is named under its own type', () => {
  for (const [kind, tld] of CREATABLE) {
    it(`${kind} → .${tld}`, () => {
      // Deployment-gated: a root this Home does not list as claimable yields undefined, and the claim is
      // REFUSED — there is no untyped root to fall to (retired 2026-11-10). The label still shows the kind's suffix.
      expect(tldOfKind(kind)).toBe(tld);
      if (!CLAIMABLE_TLDS.includes(tld)) {
        expect(typedTldForKind(kind)).toBeUndefined();
        return;
      }
      expect(typedTldForKind(kind)?.tld).toBe(tld);
    });
  }

  it('a workspace also declares its service ROLE, which a plain suffix cannot carry', () => {
    if (!CLAIMABLE_TLDS.includes('workspace')) return;
    expect(typedTldForKind('workspace')?.serviceRole).toBe('workspace');
  });

  it('an unknown kind claims nothing rather than guessing a root', () => {
    expect(typedTldForKind('data-source' as never)).toBeUndefined();
  });
});
