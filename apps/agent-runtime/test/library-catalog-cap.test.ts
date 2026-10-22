// A LIBRARY SAVE IS KEPT OR REFUSED, NEVER ACKNOWLEDGED AND LOST. The catalog write used to end in a bare
// `.slice(0, 200)`: the 201st document was answered `saved: true` with an id, then cut off the index, so the next
// step that named it (a release) found "no document named …". The Home's own Library write had the same bug and
// fixed it the same way (server/connect/library.ts, 2026-09-27).
import { describe, expect, it } from 'vitest';
import { libraryWrite, CATALOG_MAX, type LibraryEntry } from '../src/library-tools.js';

function vault() {
  const records = new Map<string, unknown>();
  return {
    records,
    deps: {
      readSubjectRecord: async (_s: string, t: string) => records.get(t) ?? null,
      writeSubjectRecord: async (_s: string, t: string, r: unknown) => (records.set(t, r), { ok: true }),
    },
  };
}
const OWNER = '0x' + 'ab'.repeat(20);
const ctx = (i: number) =>
  ({ step: { id: `s${i}` }, index: 0, supplied: [{ stepRef: `s${i}`, data: { keep: 'yes' } }], intent: { goal: 'save it' }, operationId: `op-${i}` }) as never;

describe('the Library catalog cap', () => {
  it('a save past the cap is refused in words, and every document it acknowledged is in the index', async () => {
    const { records, deps } = vault();
    // Fill the index to the cap directly (a test's arrangement), then save one more through the tool.
    const full: LibraryEntry[] = Array.from({ length: CATALOG_MAX }, (_, i) => ({ id: `doc-${i}`, kind: 'md', name: `n${i}.md`, folder: 'seed-bible' }));
    records.set('content.catalog', full);
    await expect(libraryWrite(deps, OWNER, 'library.file.save', { name: 'one-more.md', folder: 'seed-bible', text: 'x', kind: 'md' }, ctx(1))).rejects.toThrow(/holds \d+ documents/);
    expect((records.get('content.catalog') as LibraryEntry[]).length).toBe(CATALOG_MAX);
  });

  it('below the cap, the saved document is in the index under the id it was given', async () => {
    const { records, deps } = vault();
    records.set('content.catalog', Array.from({ length: 250 }, (_, i) => ({ id: `doc-${i}`, kind: 'md', name: `n${i}.md`, folder: 'seed-bible' })));
    const out = (await libraryWrite(deps, OWNER, 'library.file.save', { name: 'theme.jsonld', folder: 'seed-bible/public/customization', text: '{}', kind: 'json-ld' }, ctx(2))) as { saved: boolean; file: { id: string } };
    expect(out.saved).toBe(true);
    const ids = (records.get('content.catalog') as LibraryEntry[]).map((e) => e.id);
    expect(ids).toContain(out.file.id);
  });
});
