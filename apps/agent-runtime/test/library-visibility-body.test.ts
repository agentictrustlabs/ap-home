// A VISIBILITY CHANGE NEVER TOUCHES A DOCUMENT'S BODY. `library.file.visibility` passed the index entry to the save's
// record writer, which wrote `content.artifact.<id>` from the entry — and an index entry carries no bytes, so the record
// was rewritten without its body: the document was declared public and its text was gone.
import { describe, expect, it } from 'vitest';
import { libraryWrite, type LibraryEntry } from '../src/library-tools.js';

const OWNER = '0x' + 'ef'.repeat(20);
const ctx = (i: number) => ({ step: { id: `s${i}` }, index: 0, supplied: [{ stepRef: `s${i}`, data: { keep: 'yes' } }], intent: { goal: 'x' }, operationId: `op-${i}` }) as never;
function vault() {
  const records = new Map<string, unknown>();
  return { records, deps: { readSubjectRecord: async (_s: string, t: string) => structuredClone(records.get(t) ?? null), writeSubjectRecord: async (_s: string, t: string, r: unknown) => (records.set(t, JSON.parse(JSON.stringify(r))), { ok: true }) } };
}

describe('library.file.visibility', () => {
  it("keeps the document's body in its record", async () => {
    const { records, deps } = vault();
    const out = (await libraryWrite(deps, OWNER, 'library.file.save', { name: 'a.md', folder: 'x', text: 'the body', kind: 'md' }, ctx(1))) as { file: { id: string } };
    await libraryWrite(deps, OWNER, 'library.file.visibility', { id: out.file.id, accessPolicy: 'public' }, ctx(2));
    expect((records.get(`content.artifact.${out.file.id}`) as { bytesB64?: string }).bytesB64).toBe(btoa('the body'));
    expect((records.get('content.catalog') as LibraryEntry[])[0]!.accessPolicy).toBe('public');
  });

  it('still moves bytes an older entry carries inline into its record', async () => {
    const { records, deps } = vault();
    records.set('content.catalog', [{ id: 'art-old', kind: 'md', name: 'old.md', folder: 'x', bytesB64: btoa('inline') }]);
    await libraryWrite(deps, OWNER, 'library.file.visibility', { id: 'art-old', accessPolicy: 'public' }, ctx(3));
    expect((records.get('content.artifact.art-old') as { bytesB64: string; accessPolicy: string })).toMatchObject({ bytesB64: btoa('inline'), accessPolicy: 'public' });
    expect((records.get('content.catalog') as LibraryEntry[])[0]!.bytesB64).toBeUndefined();
  });
});
