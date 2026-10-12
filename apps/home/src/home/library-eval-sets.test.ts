// A library folder read → runnable sets: replay + gold make a set, fixtures ride along unwrapped, a replay without gold is not offered.
import { describe, expect, it } from 'vitest';
import { parseLibraryEvalSets, librarySetIdOf, librarySetParam, utf8FromB64 } from './library-eval-sets';

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
const file = (name: string, body: unknown) => ({ name, folder: 'evaluations', bytesB64: b64(body) });

describe('parseLibraryEvalSets', () => {
  it('pairs each replay with its gold, counts the intents, carries the version and the unwrapped fixtures', () => {
    const sets = parseLibraryEvalSets([
      { name: 'evaluations', folder: '', isFolder: true },
      file('scripture-cases.replay.json', { type: 'ap.replay-set.v1', id: 'scripture-cases', version: '2', title: 'Scripture — first cases', intents: [{ id: 'a' }, { id: 'b' }] }),
      file('scripture-cases.gold.json', { type: 'ap.selection-criterion.v1', cases: {} }),
      file('scripture-cases.fixtures.json', { type: 'ap.starting-state-fixtures.v1', fixtures: { base: { askerContext: {} } } }),
      file('scripture-cases.src.json', { title: 'source, not served' }),
      file('scripture-cases.v1.json', { type: 'ap.eval-version.v1' }),
      file('orphan.replay.json', { id: 'orphan', intents: [] }), // no gold → not runnable
      { name: 'notes.md', folder: 'skills/x', bytesB64: b64('x') },
    ]);
    expect(sets.map((s) => s.id)).toEqual(['scripture-cases']);
    const s = sets[0]!;
    expect(s.title).toBe('Scripture — first cases'); expect(s.cases).toBe(2); expect(s.version).toBe('2');
    expect(s.fixtures).toEqual({ base: { askerContext: {} } });
    expect((s.replay as { id: string }).id).toBe('scripture-cases');
  });
  it('decodes UTF-8 bytes and reads the deep-link form', () => {
    expect(utf8FromB64(Buffer.from('an em dash — here', 'utf8').toString('base64'))).toBe('an em dash — here');
    expect(librarySetParam('x')).toBe('library:x'); expect(librarySetIdOf('library:x')).toBe('x'); expect(librarySetIdOf('x')).toBeNull();
  });
});
