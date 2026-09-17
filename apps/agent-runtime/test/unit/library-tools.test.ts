import { describe, it, expect } from 'vitest';
import { libraryInvoker, findEntries, LIBRARY_FILES_LIST, LIBRARY_FILE_READ, type LibraryEntry } from '../../src/library-tools.js';

const ME = '0x' + 'a'.repeat(40);
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const cat: LibraryEntry[] = [
  { id: 'f1', kind: 'md', name: 'Retreat budget.md', folder: 'retreat', contentType: 'text/markdown', size: 40, version: 2, createdAt: 2, bytesB64: b64('# Budget\n\nvenue 1200\nfood 800\n') },
  { id: 'f2', kind: 'image', name: 'bulletin.png', folder: '', contentType: 'image/png', size: 5000, version: 1, createdAt: 3, bytesB64: b64('PNG…') },
  { id: 'f3', kind: 'md', name: 'Retreat notes.md', folder: 'retreat', contentType: 'text/markdown', size: 10, version: 1, createdAt: 1, bytesB64: b64('notes') },
  { id: 'd1', kind: 'md', name: 'retreat', folder: '', isFolder: true },
];
const deps = { readSubjectRecord: async (subject: string, key: string) => { if (subject !== ME) return null; if (key === 'content.catalog') return cat; const m = /^content\.artifact\.(.+)$/.exec(key); return m ? (cat.find((e) => e.id === m[1]) ?? null) : null; } };

describe('the owner\'s Library read by the owner\'s agent (spec 405)', () => {
  it('lists documents (folders excluded, bodies stripped), narrowed by folder and words', async () => {
    const inv = libraryInvoker(deps, ME);
    const all = (await inv(LIBRARY_FILES_LIST, {}, {} as never)) as { count: number; files: Array<{ path: string; text: boolean; bytesB64?: string }> };
    expect(all.count).toBe(3); expect(all.files.map((f) => f.path)).toEqual(['bulletin.png', 'retreat/Retreat budget.md', 'retreat/Retreat notes.md']); expect(all.files[0]!.text).toBe(false); expect(JSON.stringify(all)).not.toContain('bytesB64');
    const some = (await inv(LIBRARY_FILES_LIST, { folder: 'retreat', q: 'budget' }, {} as never)) as { files: Array<{ id: string }> };
    expect(some.files.map((f) => f.id)).toEqual(['f1']);
  });
  it('reads a text document by name words as untrusted evidence; names an image; asks which when two match; says what is there when none', async () => {
    const inv = libraryInvoker(deps, ME);
    const r = (await inv(LIBRARY_FILE_READ, { name: 'retreat budget' }, {} as never)) as { read: boolean; text: string; untrusted: boolean; file: { id: string } };
    expect(r.read).toBe(true); expect(r.text).toContain('venue 1200'); expect(r.untrusted).toBe(true); expect(r.file.id).toBe('f1');
    const img = (await inv(LIBRARY_FILE_READ, { name: 'bulletin' }, {} as never)) as { read: boolean; named: boolean; note: string; text?: string };
    expect(img.read).toBe(false); expect(img.named).toBe(true); expect(img.note).toMatch(/named, not read/); expect(img.text).toBeUndefined();
    const which = (await inv(LIBRARY_FILE_READ, { name: 'retreat' }, {} as never)) as { read: boolean; which?: unknown[]; refused: string };
    expect(which.read).toBe(false); expect(which.which).toHaveLength(2); expect(which.refused).toMatch(/which one/);
    const none = (await inv(LIBRARY_FILE_READ, { name: 'agenda' }, {} as never)) as { read: boolean; refused: string };
    expect(none.read).toBe(false); expect(none.refused).toMatch(/no document named "agenda"/); expect(none.refused).toContain('retreat/Retreat budget.md');
  });
  it('another owner\'s Library is not this agent\'s: the read is bound to the addressee', async () => {
    const other = libraryInvoker(deps, '0x' + 'b'.repeat(40));
    expect(((await other(LIBRARY_FILE_READ, { name: 'retreat budget' }, {} as never)) as { read: boolean; refused: string }).refused).toMatch(/holds no documents/);
    expect(findEntries(cat.filter((e) => !e.isFolder), { name: 'retreat notes', folder: 'retreat' }).map((e) => e.id)).toEqual(['f3']);
  });
});
