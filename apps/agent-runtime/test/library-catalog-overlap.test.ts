// TWO SAVES THAT OVERLAP BOTH STAY IN THE INDEX. A save reads the whole Library index, adds its entry and writes the
// index back; two saves in flight at once (a reader creating a playlist and publishing it straight away) each wrote
// back an index without the other's entry, and the next step naming the lost one (a release) found "no document named
// …". Writes now hold the owner's index (`holdCatalog`, a lease on the owner's DO) for their read→write.
import { describe, expect, it } from 'vitest';
import { libraryWrite, type LibraryEntry } from '../src/library-tools.js';

const OWNER = '0x' + 'cd'.repeat(20);
const ctx = (i: number) =>
  ({ step: { id: `s${i}` }, index: 0, supplied: [{ stepRef: `s${i}`, data: { keep: 'yes' } }], intent: { goal: 'save it' }, operationId: `op-${i}` }) as never;
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A vault whose reads and writes take a moment, as the real hop does — long enough for two saves to interleave. */
function slowVault() {
  const records = new Map<string, unknown>();
  return {
    records,
    readSubjectRecord: async (_s: string, t: string) => {
      await later(5);
      return structuredClone(records.get(t) ?? null);
    },
    writeSubjectRecord: async (_s: string, t: string, r: unknown) => {
      await later(5);
      records.set(t, structuredClone(r));
      return { ok: true };
    },
  };
}

/** The DO's lease, as one in-memory queue per owner. */
function holder() {
  let tail: Promise<void> = Promise.resolve();
  return async (_owner: string) => {
    let done!: () => void;
    const mine = new Promise<void>((r) => (done = r));
    const before = tail;
    tail = before.then(() => mine);
    await before;
    return async () => done();
  };
}

describe('overlapping Library saves', () => {
  it('keeps both documents in the index when the index is held across each save', async () => {
    const v = slowVault();
    const deps = { readSubjectRecord: v.readSubjectRecord, writeSubjectRecord: v.writeSubjectRecord, holdCatalog: holder() };
    const [a, b] = (await Promise.all([
      libraryWrite(deps, OWNER, 'library.file.save', { name: 'playlist.jsonld', folder: 'seed-bible/playlists', text: '{}', kind: 'json-ld' }, ctx(1)),
      libraryWrite(deps, OWNER, 'library.file.save', { name: 'playlist-x.jsonld', folder: 'seed-bible/public/playlist', text: '{}', kind: 'json-ld' }, ctx(2)),
    ])) as Array<{ file: { id: string } }>;
    const ids = (v.records.get('content.catalog') as LibraryEntry[]).map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining([a!.file.id, b!.file.id]));
  });

  it('releases the hold when a save is refused, so the next save is not stuck behind it', async () => {
    const v = slowVault();
    const deps = { readSubjectRecord: v.readSubjectRecord, writeSubjectRecord: async () => ({ ok: false, error: 'vault down' }), holdCatalog: holder() };
    await expect(libraryWrite(deps, OWNER, 'library.file.save', { name: 'a.md', folder: 'x', text: 'a', kind: 'md' }, ctx(3))).rejects.toThrow(/vault down/);
    const ok = { ...deps, writeSubjectRecord: v.writeSubjectRecord };
    await expect(libraryWrite(ok, OWNER, 'library.file.save', { name: 'b.md', folder: 'x', text: 'b', kind: 'md' }, ctx(4))).resolves.toMatchObject({ saved: true });
  });
});
