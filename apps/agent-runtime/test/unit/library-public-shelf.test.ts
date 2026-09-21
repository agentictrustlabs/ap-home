// Spec 412 — the public shelf: what the owner marked public, and nothing else, whoever asks.
import { describe, it, expect } from 'vitest';
import { libraryInvoker, effectiveAccessPolicy, publicShelf, LIBRARY_PUBLIC_LIST, LIBRARY_PUBLIC_READ, type LibraryEntry } from '../../src/library-tools.js';

const ME = '0x' + 'a'.repeat(40);
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const cat: LibraryEntry[] = [
  { id: 'works', kind: 'md', name: 'works', folder: 'publishing', isFolder: true, accessPolicy: 'public' },
  { id: 'w1', kind: 'md', name: 'On patience.md', folder: 'publishing/works', contentType: 'text/markdown', size: 30, version: 3, createdAt: 5, bytesB64: b64('# On patience\n\nWait well.\n'), contentCommitment: '0xabc', releases: [{ releaseId: '0xrel1', version: '1.0.0', signed: true, signature: '0xsig', publishedAt: 1_700_000_000_000, owner: ME }] },
  { id: 'w2', kind: 'md', name: 'Draft.md', folder: 'publishing/works/drafts', contentType: 'text/markdown', size: 5, version: 1, createdAt: 6, bytesB64: b64('shh') },
  { id: 'drafts', kind: 'md', name: 'drafts', folder: 'publishing/works', isFolder: true, accessPolicy: 'private' },
  { id: 'p1', kind: 'image', name: 'cover.png', folder: '', contentType: 'image/png', size: 3, version: 1, createdAt: 7, bytesB64: b64('PNG'), accessPolicy: 'public' },
  { id: 's1', kind: 'md', name: 'Secret.md', folder: 'private', contentType: 'text/markdown', size: 6, version: 1, createdAt: 8, bytesB64: b64('secret') },
];
const deps = { readSubjectRecord: async (subject: string, key: string) => { if (subject !== ME) return null; if (key === 'content.catalog') return cat; const m = /^content\.artifact\.(.+)$/.exec(key); return m ? (cat.find((e) => e.id === m[1]) ?? null) : null; } };

describe('the public shelf (spec 412)', () => {
  it('a public folder cascades; a private folder inside it does not; absent is private', () => {
    const by = (id: string) => effectiveAccessPolicy(cat, cat.find((e) => e.id === id)!);
    expect(by('w1')).toBe('public'); expect(by('w2')).toBe('private'); expect(by('p1')).toBe('public'); expect(by('s1')).toBe('private');
    expect(publicShelf(cat).map((e) => e.id).sort()).toEqual(['p1', 'w1', 'works']);
  });
  it('lists the shelf with releases and no bodies; narrows by folder', async () => {
    const inv = libraryInvoker(deps, ME);
    const all = (await inv(LIBRARY_PUBLIC_LIST, {}, {} as never)) as { count: number; files: Array<{ id: string; isFolder: boolean; release: { releaseId: string } | null }> };
    expect(all.count).toBe(3); expect(JSON.stringify(all)).not.toContain('bytesB64'); expect(JSON.stringify(all)).not.toContain('Secret');
    expect(all.files.find((f) => f.id === 'w1')!.release!.releaseId).toBe('0xrel1');
    const some = (await inv(LIBRARY_PUBLIC_LIST, { folder: 'publishing/works' }, {} as never)) as { files: Array<{ id: string }> };
    expect(some.files.map((f) => f.id).sort()).toEqual(['w1', 'works']);
  });
  it('reads a public document; a private id, a private name and a stranger\'s folder are one answer', async () => {
    const inv = libraryInvoker(deps, ME);
    const r = (await inv(LIBRARY_PUBLIC_READ, { id: 'w1' }, {} as never)) as { read: boolean; text: string; file: { release: { signed: boolean } } };
    expect(r.read).toBe(true); expect(r.text).toContain('Wait well'); expect(r.file.release.signed).toBe(true);
    const img = (await inv(LIBRARY_PUBLIC_READ, { name: 'cover' }, {} as never)) as { read: boolean; bytesB64?: string; contentType: string };
    expect(img.read).toBe(true); expect(img.bytesB64).toBe(b64('PNG')); expect(img.contentType).toBe('image/png');
    for (const args of [{ id: 's1' }, { name: 'secret' }, { id: 'w2' }, { name: 'draft', folder: 'publishing/works/drafts' }]) {
      const no = (await inv(LIBRARY_PUBLIC_READ, args, {} as never)) as { read: boolean; refused: string };
      expect(no.read).toBe(false); expect(no.refused).toMatch(/not on the public shelf|no public document/);
      expect(JSON.stringify(no)).not.toMatch(/Secret\.md|"text"|bytesB64|drafts/);
    }
  });
});
