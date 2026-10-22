// THE LIBRARY INDEX IS AN INDEX. A save used to write every document's bytes back into `content.catalog`, so each read or
// save of any document moved the whole Library through the vault (seconds a save, growing with the Library — the reader
// app's highlights paid it on every mark). Now the bytes live only in `content.artifact.<id>`: the saved document's record
// first, any older entry still carrying bytes inline migrated to its record, then the index without bytes.
import { describe, expect, it } from 'vitest';
import { libraryWrite, type LibraryEntry } from '../src/library-tools.js';

const OWNER = '0x' + 'ef'.repeat(20);
const ctx = (i: number) =>
  ({ step: { id: `s${i}` }, index: 0, supplied: [{ stepRef: `s${i}`, data: { keep: 'yes' } }], intent: { goal: 'save it' }, operationId: `op-${i}` }) as never;

function vault() {
  const records = new Map<string, unknown>();
  return {
    records,
    deps: {
      readSubjectRecord: async (_s: string, t: string) => structuredClone(records.get(t) ?? null),
      writeSubjectRecord: async (_s: string, t: string, r: unknown) => (records.set(t, structuredClone(r)), { ok: true }),
    },
  };
}

describe('the Library index', () => {
  it('carries no bytes after a save, and older inline entries move to their own records', async () => {
    const { records, deps } = vault();
    const old: LibraryEntry = { id: 'art-old', kind: 'md', name: 'old.md', folder: 'x', bytesB64: btoa('old text'), version: 1 };
    records.set('content.catalog', [old]);
    const out = (await libraryWrite(deps, OWNER, 'library.file.save', { name: 'new.md', folder: 'x', text: 'new text', kind: 'md' }, ctx(1))) as { file: { id: string } };
    const index = records.get('content.catalog') as LibraryEntry[];
    expect(index.map((e) => e.id).sort()).toEqual(['art-old', out.file.id].sort());
    expect(index.every((e) => e.bytesB64 === undefined)).toBe(true);
    expect(index.find((e) => e.id === out.file.id)?.size).toBeGreaterThan(0);
    expect((records.get(`content.artifact.${out.file.id}`) as { bytesB64: string }).bytesB64).toBe(btoa('new text'));
    expect((records.get('content.artifact.art-old') as { bytesB64: string }).bytesB64).toBe(btoa('old text'));
  });

  it('writes nothing of the index when a document record is refused', async () => {
    const { records, deps } = vault();
    records.set('content.catalog', []);
    const refusing = { ...deps, writeSubjectRecord: async (s: string, t: string, r: unknown) => (t.startsWith('content.artifact.') ? { ok: false, error: 'vault refused' } : deps.writeSubjectRecord(s, t, r)) };
    await expect(libraryWrite(refusing, OWNER, 'library.file.save', { name: 'a.md', folder: 'x', text: 'a', kind: 'md' }, ctx(2))).rejects.toThrow(/vault refused/);
    expect(records.get('content.catalog')).toEqual([]);
  });
});

describe('a re-save and a read by id', () => {
  it('re-saves a document as a new version and reads it back by id', async () => {
    const { records, deps } = vault();
    records.set('content.catalog', []);
    const first = (await libraryWrite(deps, OWNER, 'library.file.save', { name: 'b.jsonld', folder: 'x', text: 'v1', kind: 'json-ld' }, ctx(3))) as { file: { id: string } };
    const again = (await libraryWrite(deps, OWNER, 'library.file.save', { name: 'b.jsonld', folder: 'x', text: 'v2', kind: 'json-ld', id: first.file.id }, ctx(4))) as { file: { id: string; version: number } };
    expect(again.file).toMatchObject({ id: first.file.id, version: 2 });
    expect((records.get(`content.artifact.${first.file.id}`) as { bytesB64: string }).bytesB64).toBe(btoa('v2'));
    const index = records.get('content.catalog') as LibraryEntry[];
    expect(index).toHaveLength(1);
    expect(index[0]!.bytesB64).toBeUndefined();
  });

  it('a re-save whose record is refused fails, and the document still reads as its previous text', async () => {
    const { records, deps } = vault();
    records.set('content.catalog', []);
    const first = (await libraryWrite(deps, OWNER, 'library.file.save', { name: 'c.md', folder: 'x', text: 'kept', kind: 'md' }, ctx(5))) as { file: { id: string } };
    const refusing = { ...deps, writeSubjectRecord: async (s: string, t: string, r: unknown) => (t.startsWith('content.artifact.') ? { ok: false, error: 'vault refused' } : deps.writeSubjectRecord(s, t, r)) };
    await expect(libraryWrite(refusing, OWNER, 'library.file.save', { name: 'c.md', folder: 'x', text: 'lost', kind: 'md', id: first.file.id }, ctx(6))).rejects.toThrow(/vault refused/);
    expect((records.get(`content.artifact.${first.file.id}`) as { bytesB64: string }).bytesB64).toBe(btoa('kept'));
  });
});
