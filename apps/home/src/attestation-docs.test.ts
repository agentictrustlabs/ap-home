import { describe, expect, it } from 'vitest';
import { WEA_DOC_ID, WEA_TEXT, weaDocHash } from './wea-doc';
import { buildAttestation, findDocument, inlineTextHash, returnParams, storedFor } from './attestation-docs';
import { ATTESTABLE_DOCUMENTS } from './whitelabel/attestable-documents';
import { readWorkAnswer, verifyUrlFor } from './lib/published-work';
import type { StoredAttestation } from './profile-store';

/** The WEA bytes as they were when members first signed. A change here is a breaking change for every prior
 *  signature — it must be a decision, never a side effect of a refactor. */
const WEA_HASH_2026_10 = '0x8a2f35bdf750ebcbbbdec9ae44e83609d7fa1429341e538ff4b9b134db7d19e6';

describe('attestable documents', () => {
  it('keeps the WEA bytes and hash unchanged', async () => {
    expect(await weaDocHash()).toBe(WEA_HASH_2026_10);
    expect(await inlineTextHash(WEA_TEXT)).toBe(WEA_HASH_2026_10);
    const wea = findDocument(ATTESTABLE_DOCUMENTS, WEA_DOC_ID);
    expect(wea?.commitment).toEqual({ kind: 'inline-text', text: WEA_TEXT });
  });

  it('keeps the WEA wire contract: storage key `wea`, return prefix `wea`', () => {
    const wea = findDocument(ATTESTABLE_DOCUMENTS, WEA_DOC_ID)!;
    expect(wea.storageKey).toBe('wea');
    expect(wea.returnPrefix).toBe('wea');
  });

  it('has unique ids and storage keys, and kinds that name a mechanism, not a product', () => {
    const ids = ATTESTABLE_DOCUMENTS.map((d) => d.id);
    const keys = ATTESTABLE_DOCUMENTS.map((d) => d.storageKey);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of ATTESTABLE_DOCUMENTS) expect(['inline-text', 'signed-release']).toContain(d.commitment.kind);
  });

  it('builds an inline-text record without a source, and a signed-release record with one', () => {
    const wea = findDocument(ATTESTABLE_DOCUMENTS, WEA_DOC_ID)!;
    const a = buildAttestation(wea, { docHash: WEA_HASH_2026_10 }, '0xbound', 1_700_000_000_000);
    expect(a).toEqual({ docHash: WEA_HASH_2026_10, docId: WEA_DOC_ID, signedAt: 1_700_000_000, consentBoundTo: '0xbound' });
    expect('source' in a).toBe(false);

    const lausanne = findDocument(ATTESTABLE_DOCUMENTS, 'lausanne-covenant-1974')!;
    const source = {
      kind: 'signed-release' as const, endpoint: 'https://publishing.example/api/a2a', publisher: '0xabc', handle: 'lausanne-movement',
      slug: 'the-lausanne-covenant', version: 1, contentCommitment: '0xcc', releaseId: '0xrel', sourceUrl: lausanne.sourceUrl,
    };
    const b = buildAttestation(lausanne, { docHash: '0xroot', source }, '0xbound', 1_700_000_000_000);
    expect(b.source).toEqual(source);
    expect(b.docHash).toBe('0xroot');
  });

  it('returns wea_* params for the WEA and <prefix>_* plus provenance for a signed release', () => {
    const wea = findDocument(ATTESTABLE_DOCUMENTS, WEA_DOC_ID)!;
    const a: StoredAttestation = { docHash: '0xh', docId: WEA_DOC_ID, signedAt: 1, consentBoundTo: '0xb' };
    expect(returnParams(wea, a)).toEqual({ wea_docHash: '0xh', wea_docId: WEA_DOC_ID, wea_signedAt: '1', wea_consentBoundTo: '0xb' });

    const lausanne = findDocument(ATTESTABLE_DOCUMENTS, 'lausanne-covenant-1974')!;
    const b: StoredAttestation = {
      docHash: '0xroot', docId: lausanne.id, signedAt: 2, consentBoundTo: '0xb',
      source: { kind: 'signed-release', endpoint: 'e', publisher: '0xp', handle: 'h', slug: 's', version: 3, contentCommitment: '0xcc', releaseId: '0xr' },
    };
    expect(returnParams(lausanne, b)).toMatchObject({
      att_docHash: '0xroot', att_docId: lausanne.id, att_kind: 'signed-release', att_publisher: '0xp', att_handle: 'h', att_slug: 's', att_version: '3', att_releaseId: '0xr',
    });
  });

  it('finds a stored record by the document’s storage key', () => {
    const wea = findDocument(ATTESTABLE_DOCUMENTS, WEA_DOC_ID)!;
    const rec: StoredAttestation = { docHash: '0xh', docId: WEA_DOC_ID, signedAt: 1, consentBoundTo: '0xb' };
    expect(storedFor({ wea: rec }, wea)).toBe(rec);
    expect(storedFor({}, wea)).toBeNull();
    expect(storedFor(undefined, wea)).toBeNull();
  });
});

describe('reading a published work', () => {
  const root = '0x' + '1d'.repeat(32);
  const good = {
    work: {
      title: 'The Lausanne Covenant', url: 'https://reader.example/@lausanne-movement/the-lausanne-covenant', handle: 'lausanne-movement', slug: 'the-lausanne-covenant',
      version: 1, author: '0xABCDEF', workRoot: root, contentCommitment: '0xcc', signatureStatus: 'verified', partCount: 17,
      manifest: { content: { workRoot: root, partCount: 17, parts: [] } },
      release: { releaseId: '0xrel', version: '1.0.0', owner: '0xABCDEF', signed: true },
    },
  };
  const expect_ = { handle: 'lausanne-movement', slug: 'the-lausanne-covenant' };

  it('turns a work answer into a commitment and a bound source', () => {
    const r = readWorkAnswer(good, 'https://publishing.example/api/a2a', 'https://lausanne.org/statement/lausanne-covenant', expect_);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.docHash).toBe(root);
    expect(r.source).toEqual({
      kind: 'signed-release', endpoint: 'https://publishing.example/api/a2a', publisher: '0xabcdef', handle: 'lausanne-movement', slug: 'the-lausanne-covenant',
      version: 1, contentCommitment: '0xcc', releaseId: '0xrel', sourceUrl: 'https://lausanne.org/statement/lausanne-covenant',
    });
    expect(r.partCount).toBe(17);
  });

  it('refuses a work for a different handle or slug', () => {
    const r = readWorkAnswer(good, 'e', undefined, { handle: 'someone-else', slug: 'the-lausanne-covenant' });
    expect(r.ok).toBe(false);
  });

  it('refuses a root that disagrees with the manifest, and a work without a release', () => {
    const bad = { work: { ...good.work, manifest: { content: { workRoot: '0x' + '2d'.repeat(32) } } } };
    expect(readWorkAnswer(bad, 'e', undefined, expect_).ok).toBe(false);
    const unsigned = { work: { ...good.work, release: undefined } };
    expect(readWorkAnswer(unsigned, 'e', undefined, expect_).ok).toBe(false);
  });

  it('finds the gateway verifier beside the A2A interface', () => {
    expect(verifyUrlFor('https://publishing.faithnet.io/api/a2a', 'lausanne-movement', 'the-lausanne-covenant'))
      .toBe('https://publishing.faithnet.io/api/public/lausanne-movement/the-lausanne-covenant/verify');
  });
});
