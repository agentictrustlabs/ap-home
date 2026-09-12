import { describe, it, expect } from 'vitest';
import { artifactIdentity, accessMethodOf } from './artifact-identity';
const OWNER = { sa: '0x1111111111111111111111111111111111111111', vaultLabel: 'Person vault' };
describe('artifact identity (398 §6.2)', () => {
  it('the four access methods, from access mode and source', () => {
    expect(accessMethodOf({ source: 'blob' })).toBe('owned locally');
    expect(accessMethodOf({ source: 'external' })).toBe('live remote');
    expect(accessMethodOf({ source: 'blob', accessMode: 'Read-through' })).toBe('live remote');
    expect(accessMethodOf({ source: 'blob', accessMode: 'Replica' })).toBe('authorized replica');
    expect(accessMethodOf({ source: 'graphdb', accessMode: 'Projection' })).toBe('derived copy');
  });
  it('version · author · sources · scope · linked item (absent) · three distinct acts', () => {
    const id = artifactIdentity({ id: 'a', name: 'brief.md', version: 3, source: 'blob', discussionId: 't1', contentCommitment: '0xabc', createdAt: 1,
      grants: [{ grantee: { address: '0x2' } }, { grantee: { address: '0x3' }, revoked: true }], releases: [{ version: '1.0.0', publisher: '0x1', publishedAt: 5 }] }, OWNER, true);
    expect(id.version).toBe('v3'); expect(id.author).toBe(OWNER.sa);
    expect(id.sources.map((s) => s.kind)).toEqual(['topic', 'commitment']);
    expect(id.scope).toEqual({ vault: 'Person vault', grants: 2, live: 1 });
    expect(id.linkedWorkItem).toBeNull();
    expect(id.acts).toEqual({ share: 'offered', publish: 'offered', replicate: 'not-yet' });
    expect(id.latestRelease?.version).toBe('1.0.0');
  });
  it('a shared artifact names its sharer as author and offers neither share nor publish', () => {
    const id = artifactIdentity({ id: 'b', name: 'x', source: 'blob', createdAt: 1, accessMode: 'Replica', sharedBy: '0x9' }, OWNER, false);
    expect(id.author).toBe('0x9'); expect(id.accessMethod).toBe('authorized replica');
    expect(id.acts.share).toBe('not-owner'); expect(id.acts.publish).toBe('not-owner');
  });
});
