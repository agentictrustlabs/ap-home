// Spec 412 W5 — the owner's own Library writes, by the owner's agent: save / visibility / publish, self-acting.
import { describe, it, expect } from 'vitest';
import { canonicalHash } from '@agenticprimitives/verifiable-credentials';
import { libraryInvoker, releaseCore, stewardshipOver, LIBRARY_FILE_SAVE, LIBRARY_FILE_VISIBILITY, LIBRARY_FILE_PUBLISH, LIBRARY_PUBLIC_LIST, type LibraryEntry } from '../../src/library-tools.js';

const ME = '0x' + 'a'.repeat(40);
const OTHER = '0x' + 'b'.repeat(40);
const store = new Map<string, unknown>();
const deps = {
  readSubjectRecord: async (subject: string, key: string) => (subject === ME ? store.get(key) ?? null : null),
  writeSubjectRecord: async (subject: string, key: string, record: unknown) => { if (subject !== ME) return { ok: false, error: 'not mine' }; store.set(key, record); return { ok: true }; },
  signAsOwner: async (_owner: string, digest: `0x${string}`) => `0xsig-${digest.slice(2, 10)}` as `0x${string}`,
};
const ctx = (goal = 'save my page') => ({ intent: { goal }, step: { id: 's1' }, index: 0, operationId: 'op-1', supplied: [] }) as never;
const catalog = () => (store.get('content.catalog') as LibraryEntry[]) ?? [];

describe('the Library written by its own agent (spec 412 W5)', () => {
  it('saves a page (a new version on re-save, policy and releases kept), a folder, and the artifact record', async () => {
    const inv = libraryInvoker(deps, ME, ME);
    const r1 = (await inv(LIBRARY_FILE_SAVE, { id: 'pg-1', name: 'On patience.md', folder: 'publishing/works', text: '# On patience\n\nWait well.', accessPolicy: 'public' }, ctx())) as { saved: boolean; file: { version: number; commitment: string }; effectiveAccessPolicy: string };
    expect(r1.saved).toBe(true); expect(r1.file.version).toBe(1); expect(r1.effectiveAccessPolicy).toBe('public');
    expect((store.get('content.artifact.pg-1') as { accessPolicy?: string; commitment?: string }).accessPolicy).toBe('public');
    const r2 = (await inv(LIBRARY_FILE_SAVE, { id: 'pg-1', name: 'On patience.md', folder: 'publishing/works', text: '# On patience\n\nWait well, v2.' }, ctx())) as { file: { version: number; commitment: string; accessPolicy: string } };
    expect(r2.file.version).toBe(2); expect(r2.file.accessPolicy).toBe('public'); expect(r2.file.commitment).not.toBe(r1.file.commitment);
    const f = (await inv(LIBRARY_FILE_SAVE, { name: 'drafts', folder: 'publishing/works', isFolder: true }, ctx())) as { file: { isFolder: boolean; id: string } };
    expect(f.file.isFolder).toBe(true); expect(catalog()).toHaveLength(2);
    expect(store.has(`content.artifact.${f.file.id}`)).toBe(false);
  });
  it('mints a release whose id is the Home\'s derivation, signed as the owner, and appends on a second publish', async () => {
    const inv = libraryInvoker(deps, ME, ME);
    const p = (await inv(LIBRARY_FILE_PUBLISH, { id: 'pg-1' }, ctx('publish it'))) as { published: boolean; release: { releaseId: string; version: string; signed: boolean; signature: string } };
    const art = catalog().find((e) => e.id === 'pg-1')!;
    const canonicalId = canonicalHash({ page: art.name, kind: art.kind });
    const bundleRoot = canonicalHash({ root: art.contentCommitment });
    const expected = canonicalHash({ canonicalId, version: '1.0.0', bundleRoot, owner: ME, publisher: ME, lockDigest: canonicalHash([]), risk: { riskTier: 'low', requestedCapabilities: ['read'] } });
    expect(p.release.releaseId).toBe(expected); expect(p.release.version).toBe('1.0.0'); expect(p.release.signed).toBe(true);
    expect(releaseCore({ ...art, releases: [p.release] }, catalog(), ME).version).toBe('2.0.0');
    const p2 = (await inv(LIBRARY_FILE_PUBLISH, { name: 'on patience' }, ctx('publish it'))) as { release: { version: string } };
    expect(p2.release.version).toBe('2.0.0'); expect(catalog().find((e) => e.id === 'pg-1')!.releases).toHaveLength(2);
    // A re-save after publishing keeps the chain.
    await inv(LIBRARY_FILE_SAVE, { id: 'pg-1', name: 'On patience.md', folder: 'publishing/works', text: 'v3' }, ctx());
    expect(catalog().find((e) => e.id === 'pg-1')!.releases).toHaveLength(2);
  });
  it('declares visibility, and the public shelf follows', async () => {
    const inv = libraryInvoker(deps, ME, ME);
    const v = (await inv(LIBRARY_FILE_VISIBILITY, { id: 'pg-1', accessPolicy: 'private' }, ctx('make it private'))) as { declared: boolean; effectiveAccessPolicy: string };
    expect(v.declared).toBe(true); expect(v.effectiveAccessPolicy).toBe('private');
    expect(((await inv(LIBRARY_PUBLIC_LIST, {}, ctx())) as { count: number }).count).toBe(0);
    await inv(LIBRARY_FILE_VISIBILITY, { name: 'drafts', accessPolicy: 'public' }, ctx('make drafts public'));
    expect(((await inv(LIBRARY_PUBLIC_LIST, {}, ctx())) as { count: number }).count).toBe(1);
    await expect(inv(LIBRARY_FILE_VISIBILITY, { id: 'pg-1', accessPolicy: 'everyone' }, ctx())).rejects.toThrow(/public.*private/);
  });
  it('is the owner\'s own act: another principal, a room, or an unattended run is refused', async () => {
    const asOther = libraryInvoker(deps, ME, OTHER);
    expect(((await asOther(LIBRARY_FILE_SAVE, { name: 'x.md', text: 'x' }, ctx())) as { refused?: string }).refused).toMatch(/own agent or by a steward of it — this deployment cannot judge stewardship/);
    const nobody = libraryInvoker(deps, ME, undefined);
    await expect(nobody(LIBRARY_FILE_SAVE, { name: 'x.md', text: 'x' }, ctx())).rejects.toThrow(/signed-in person/);
    const mine = libraryInvoker(deps, ME, ME);
    const fired = { intent: { goal: 'save', context: { trigger: 'schedule' } }, step: { id: 's1' }, index: 0, operationId: 'op', supplied: [] } as never;
    await expect(mine(LIBRARY_FILE_SAVE, { name: 'x.md', text: 'x' }, fired)).rejects.toThrow(/own turn/);
    expect(catalog().some((e) => e.name === 'x.md')).toBe(false);
  });
});

describe('a steward writes the Library of an agent it stewards (publisher-as-service)', () => {
  const PERSON = '0x' + '1'.repeat(40);
  const ORG = '0x' + '2'.repeat(40);
  const SVC = '0x' + '3'.repeat(40);
  const STRANGER = '0x' + '4'.repeat(40);
  const wire = (from: string, to: string) => ({ delegator: from, delegate: to, signature: '0xok', caveats: [] });
  const links: Record<string, unknown> = {
    [ORG]: { org: ORG, orgName: 'press.org', relationship: 'steward', kind: 'org', parent: PERSON, delegations: [wire(ORG, PERSON)] },
    [SVC]: { org: SVC, orgName: 'press.svc', relationship: 'steward', kind: 'service', parent: ORG, delegations: [wire(SVC, ORG)] },
  };
  const trees: Record<string, unknown> = { [PERSON]: { orgs: links }, [STRANGER]: { orgs: {} } };
  const valid = new Set([`${ORG}>${PERSON}`, `${SVC}>${ORG}`]);
  const standing = {
    readSubjectRecord: async (subject: string, key: string) => (key === 'relationships.data' ? trees[subject] ?? null : null),
    verifyStewardship: async ({ org, person, wire: w }: { org: string; person: string; wire: unknown }) => {
      const d = w as { delegator: string; delegate: string };
      return d.delegator === org && d.delegate === person && valid.has(`${org}>${person}`);
    },
  };
  it('counts a direct steward and a steward of the parent the agent is chartered under', async () => {
    expect((await stewardshipOver(standing as never, PERSON, ORG)).steward).toBe(true);
    const through = await stewardshipOver(standing as never, PERSON, SVC);
    expect(through.steward).toBe(true); expect(through.because).toMatch(/chartered under/);
  });
  it('refuses a stranger, a grant that does not verify, and a routed ask', async () => {
    expect((await stewardshipOver(standing as never, STRANGER, SVC)).steward).toBe(false);
    valid.delete(`${SVC}>${ORG}`);
    const broken = await stewardshipOver(standing as never, PERSON, SVC);
    expect(broken.steward).toBe(false); expect(broken.because).toMatch(/does not verify on chain/);
    valid.add(`${SVC}>${ORG}`);
    expect((await stewardshipOver({ ...standing, context: { routed: true } } as never, PERSON, SVC)).steward).toBe(false);
  });
  it('lands the write in the OWNER\'s vault and signs the release as the owner', async () => {
    const vault = new Map<string, unknown>();
    const signedAs: string[] = [];
    const d = {
      readSubjectRecord: async (subject: string, key: string) => (subject === SVC ? vault.get(key) ?? null : null),
      writeSubjectRecord: async (subject: string, key: string, record: unknown) => { if (subject !== SVC) return { ok: false, error: 'wrong vault' }; vault.set(key, record); return { ok: true }; },
      signAsOwner: async (owner: string, digest: `0x${string}`) => { signedAs.push(owner); return `0xsig-${digest.slice(2, 10)}` as `0x${string}`; },
      stewardOf: (who: string, owner: string) => stewardshipOver(standing as never, who, owner),
    };
    const inv = libraryInvoker(d, SVC, PERSON);
    const saved = (await inv(LIBRARY_FILE_SAVE, { id: 'w-1', kind: 'json-ld', name: 'a-work', folder: 'publishing/works', text: '{}' }, ctx())) as { saved: boolean; owner: string };
    expect(saved.saved).toBe(true); expect(saved.owner).toBe(SVC);
    const pub = (await inv(LIBRARY_FILE_PUBLISH, { id: 'w-1' }, ctx('publish it'))) as { release: { owner: string; publisher: string } };
    expect(pub.release.owner).toBe(SVC); expect(pub.release.publisher).toBe(SVC); expect(signedAs).toEqual([SVC]);
    const stranger = libraryInvoker(d, SVC, STRANGER);
    expect(((await stranger(LIBRARY_FILE_SAVE, { name: 'x', text: 'x' }, ctx())) as { refused?: string }).refused).toMatch(/steward/);
  });
});
