// Spec 413 W2 — after a Library act the owner's agent tells the public tier's indexer which document may have changed:
// two public identifiers, no content, never fatal to the act. And a long public page is read whole, in slices.
import { describe, it, expect } from 'vitest';
import { libraryInvoker, LIBRARY_FILE_SAVE, LIBRARY_FILE_VISIBILITY, LIBRARY_FILE_PUBLISH, LIBRARY_PUBLIC_READ, LIBRARY_TEXT_MAX_CHARS } from '../../src/library-tools.js';

const ME = '0x' + 'c'.repeat(40);
const ctx = (goal = 'save my page') => ({ intent: { goal }, step: { id: 's1' }, index: 0, operationId: 'op-1', supplied: [] }) as never;

function setup(announce: (owner: string, id: string) => Promise<void>) {
  const store = new Map<string, unknown>();
  const deps = {
    readSubjectRecord: async (_s: string, key: string) => store.get(key) ?? null,
    writeSubjectRecord: async (_s: string, key: string, record: unknown) => { store.set(key, record); return { ok: true }; },
    signAsOwner: async (_o: string, d: `0x${string}`) => `0xsig${d.slice(2, 10)}` as `0x${string}`,
    announce,
  };
  return libraryInvoker(deps, ME, ME);
}

describe('shelf hints (spec 413)', () => {
  it('announces a public save, a publish and a visibility change — and not a private save', async () => {
    const hints: Array<[string, string]> = [];
    const inv = setup(async (o, id) => { hints.push([o, id]); });
    await inv(LIBRARY_FILE_SAVE, { id: 'priv-1', name: 'notes.md', text: 'mine' }, ctx());
    expect(hints).toEqual([]);
    await inv(LIBRARY_FILE_SAVE, { id: 'pub-1', name: 'essay.md', text: 'hello', accessPolicy: 'public' }, ctx());
    await inv(LIBRARY_FILE_PUBLISH, { id: 'pub-1' }, ctx('publish it'));
    await inv(LIBRARY_FILE_VISIBILITY, { id: 'pub-1', accessPolicy: 'private' }, ctx('make it private'));
    expect(hints).toEqual([[ME, 'pub-1'], [ME, 'pub-1'], [ME, 'pub-1']]);
  });

  it('a folder made public announces every document under it', async () => {
    const hints: string[] = [];
    const inv = setup(async (_o, id) => { hints.push(id); });
    await inv(LIBRARY_FILE_SAVE, { name: 'works', isFolder: true }, ctx());
    await inv(LIBRARY_FILE_SAVE, { id: 'w-1', name: 'a.md', folder: 'works', text: 'a' }, ctx());
    await inv(LIBRARY_FILE_SAVE, { id: 'w-2', name: 'b.md', folder: 'works', text: 'b' }, ctx());
    await inv(LIBRARY_FILE_VISIBILITY, { name: 'works', accessPolicy: 'public' }, ctx('make works public'));
    expect(hints.sort()).toEqual(['w-1', 'w-2']);
  });

  it('a failing hint never fails the act', async () => {
    const inv = setup(async () => { throw new Error('queue down'); });
    const r = (await inv(LIBRARY_FILE_SAVE, { id: 'pub-2', name: 'x.md', text: 'x', accessPolicy: 'public' }, ctx())) as { saved: boolean };
    expect(r.saved).toBe(true);
  });

  it('the public read pages a long document by offset, so it can be read whole', async () => {
    const inv = setup(async () => undefined);
    const long = 'word '.repeat(Math.ceil((LIBRARY_TEXT_MAX_CHARS * 1.5) / 5));
    await inv(LIBRARY_FILE_SAVE, { id: 'long-1', name: 'long.md', text: long, accessPolicy: 'public' }, ctx());
    const p1 = (await inv(LIBRARY_PUBLIC_READ, { id: 'long-1' }, ctx())) as { text: string; chars: number; truncated: boolean };
    expect(p1.truncated).toBe(true);
    const p2 = (await inv(LIBRARY_PUBLIC_READ, { id: 'long-1', offset: p1.text.length }, ctx())) as { text: string; truncated: boolean };
    expect(p2.truncated).toBe(false);
    expect(p1.text + p2.text).toBe(long);
  });
});
