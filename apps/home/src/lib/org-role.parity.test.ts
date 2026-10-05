// The role-offer rules are ONE file kept in two apps (the runtime that records a membership, the Home that stores
// an invitation). Two copies that drift would let the Home accept an offer the object later refuses to read — a
// role silently lost at the join. This fails the moment they differ.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseRoleOffer } from './org-role';

const here = dirname(fileURLToPath(import.meta.url));

describe('org-role.ts is the same file in the Home and in the runtime', () => {
  it('byte for byte', () => {
    const home = readFileSync(resolve(here, 'org-role.ts'), 'utf8');
    const runtime = readFileSync(resolve(here, '../../../agent-runtime/src/org-role.ts'), 'utf8');
    expect(home).toBe(runtime);
  });
  it('and it loads here', () => {
    const p = parseRoleOffer({ type: 'ap.org.role-offer.v1', roleDefinitionId: `roledef:0x${'1'.repeat(40)}:coach@1`, name: 'Coach', description: '', scope: 'organization', skillPackRefs: [] });
    expect(p.ok).toBe(true);
  });
});
