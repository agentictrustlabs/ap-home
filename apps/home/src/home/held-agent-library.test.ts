import { describe, it, expect } from 'vitest';
import { normalizeCatalogEntry, readHeldAgentCatalog, readHeldAgentArtifactBody, type DelegatedRecordReader } from './held-agent-library';
import type { DelegationWire } from '../lib/delegation';

const SVC = '0x4ccf290fdbf15638b349e0ef8f7700d82f40ce37';
const PERSON = '0x5d7197f8000000000000000000000000ba790b00';
const wire = { delegator: SVC, delegate: PERSON } as unknown as DelegationWire;

// The records the live defect showed on `gc-test-org.svc` (2026-09-23): an index written by the agent's own
// `library.file.save`, with a folder, three documents, and one public entry.
const CATALOG = [
  { id: 'publishing', kind: 'md', name: 'publishing', source: 'blob', folder: '', isFolder: true, contentType: 'inode/directory', size: 0, createdAt: 1, version: 1, grants: [], accessPolicy: 'public' },
  { id: 'publishing-profile-1', kind: 'json-ld', name: 'profile.jsonld', source: 'blob', folder: 'publishing', contentType: 'application/ld+json', bytesB64: btoa('{"a":1}'), size: 8, createdAt: 1758600000000, version: 1, contentCommitment: '0xabc', grants: [] },
  { id: 'publishing-works-test-content-1', kind: 'md', name: 'test-content-1', folder: 'publishing/works', createdAt: 1758600000001, version: 2, grants: [], releases: [{ version: '1.0.0', publisher: SVC, publishedAt: 1 }] },
  { id: 'publishing-works-test-content-1-md', kind: 'md', name: 'test-content-1.md', folder: 'publishing/works', createdAt: 1758600000002, version: 1, grants: [], commitment: '0xdef' },
];

function reader(records: Record<string, unknown>): { read: DelegatedRecordReader; asked: Array<{ d: DelegationWire; rt: string }> } {
  const asked: Array<{ d: DelegationWire; rt: string }> = [];
  return { asked, read: async (d, rt) => { asked.push({ d, rt }); return rt in records ? records[rt] : null; } };
}

describe('held-agent library — read over the stewardship delegation', () => {
  it('reads content.catalog from the AGENT’S vault with the delegation it is given', async () => {
    const r = reader({ 'content.catalog': CATALOG });
    const list = await readHeldAgentCatalog(wire, r.read);
    expect(r.asked).toEqual([{ d: wire, rt: 'content.catalog' }]);
    expect(list.map((a) => a.id)).toEqual(CATALOG.map((a) => a.id));
    expect(list.filter((a) => a.isFolder).map((a) => a.name)).toEqual(['publishing']);
  });

  it('keeps what the writer recorded — releases, the declared policy, the commitment under either name', async () => {
    const list = await readHeldAgentCatalog(wire, reader({ 'content.catalog': CATALOG }).read);
    const byId = Object.fromEntries(list.map((a) => [a.id, a]));
    expect(byId.publishing!.accessPolicy).toBe('public');
    expect(byId['publishing-works-test-content-1']!.releases).toHaveLength(1);
    expect(byId['publishing-profile-1']!.contentCommitment).toBe('0xabc');
    expect(byId['publishing-works-test-content-1-md']!.contentCommitment).toBe('0xdef');
  });

  it('fills only the defaults the Home’s own upsert would have written', async () => {
    const [e] = await readHeldAgentCatalog(wire, reader({ 'content.catalog': [{ id: 'x', name: 'x.md', kind: 'weird' }] }).read);
    expect(e).toEqual({ id: 'x', kind: 'md', name: 'x.md', source: 'blob', folder: '', contentType: 'text/markdown', size: 0, createdAt: 0, grants: [] });
  });

  it('an absent catalog is an empty Library', async () => {
    expect(await readHeldAgentCatalog(wire, reader({}).read)).toEqual([]);
  });

  it('a catalog that is not a list is SAID, not rendered empty', async () => {
    await expect(readHeldAgentCatalog(wire, reader({ 'content.catalog': { entries: [] } }).read)).rejects.toThrow(/not a list/);
  });

  it('a failed vault read propagates', async () => {
    const read: DelegatedRecordReader = async () => { throw new Error('delegation revoked'); };
    await expect(readHeldAgentCatalog(wire, read)).rejects.toThrow('delegation revoked');
  });

  it('drops rows that are not entries (no id or name)', () => {
    expect(normalizeCatalogEntry(null)).toBeNull();
    expect(normalizeCatalogEntry({ id: 'a' })).toBeNull();
    expect(normalizeCatalogEntry({ name: 'a' })).toBeNull();
  });

  it('reads a document’s body from its own content.artifact.<id> record', async () => {
    const r = reader({ 'content.artifact.doc-1': { id: 'doc-1', bytesB64: btoa('hello'), contentType: 'text/markdown' } });
    expect(await readHeldAgentArtifactBody(wire, 'doc-1', r.read)).toEqual({ bytesB64: btoa('hello'), contentType: 'text/markdown' });
    expect(r.asked[0]!.rt).toBe('content.artifact.doc-1');
    expect(await readHeldAgentArtifactBody(wire, 'missing', r.read)).toBeNull();
  });
});
