import { describe, expect, it } from 'vitest';
import { agreementRows, isAgreementRecordType, releaseUrl, withdrawn, type AgreementAcceptanceRecord } from './agreement-rows';

const accepted: AgreementAcceptanceRecord = {
  app: 'demo-terms',
  agreementId: 'terms',
  agreementVersion: '1.0',
  title: 'Terms of use',
  release: { publisher: '0xabc', handle: 'terms-demo', slug: 'terms-of-use-v1-0', releaseId: 'rel-1', workRoot: '0x11', sha256: 'aa' },
  signedAt: 1_760_000_000,
  signature: '0xsig',
};

describe('agreement rows', () => {
  it('builds rows from agreement records, newest first, and ignores every other record type', () => {
    const rows = agreementRows([
      { recordType: 'impact-profile', record: { name: 'x' } },
      { recordType: 'agreement-acceptance:rel-0', record: { ...accepted, title: 'Older', release: { releaseId: 'rel-0' }, signedAt: 1_750_000_000 } },
      { recordType: 'agreement-acceptance:rel-1', record: accepted },
      { recordType: 'agreement-acceptance:bad', record: 'not an object' },
      { recordType: 'friend:0x1', record: {} },
    ]);
    expect(rows.map((r) => r.releaseId)).toEqual(['rel-1', 'rel-0']);
    expect(rows[0]).toMatchObject({ recordType: 'agreement-acceptance:rel-1', app: 'demo-terms', title: 'Terms of use', agreementVersion: '1.0', publisher: 'terms-demo', signedAt: 1_760_000_000, withdrawnAt: null });
    expect(rows[1].publisher).toBe('');
  });

  it('tolerates a record with nothing in it', () => {
    const [row] = agreementRows([{ recordType: 'agreement-acceptance:rel-9', record: {} }]);
    expect(row).toMatchObject({ app: '', title: '', agreementVersion: '', publisher: '', releaseId: 'rel-9', signedAt: null, withdrawnAt: null });
    expect(releaseUrl('https://publishing.example', row)).toBeNull();
  });

  it('a withdrawn payload adds withdrawnAt and changes nothing else', () => {
    const out = withdrawn(accepted, '2026-10-30T12:00:00.000Z');
    expect(out.withdrawnAt).toBe('2026-10-30T12:00:00.000Z');
    const { withdrawnAt: _w, ...rest } = out;
    expect(rest).toEqual(accepted);
    expect(accepted.withdrawnAt).toBeUndefined(); // the input is not mutated
  });

  it('a withdrawn row is marked, so the page renders no Withdraw button for it', () => {
    const [row] = agreementRows([{ recordType: 'agreement-acceptance:rel-1', record: withdrawn(accepted, '2026-10-30T12:00:00.000Z') }]);
    expect(row.withdrawnAt).toBe('2026-10-30T12:00:00.000Z');
  });

  it('links to the release page only when handle and slug are both present', () => {
    const [row] = agreementRows([{ recordType: 'agreement-acceptance:rel-1', record: accepted }]);
    expect(releaseUrl('https://publishing.example/', row)).toBe('https://publishing.example/@terms-demo/terms-of-use-v1-0');
    const [noSlug] = agreementRows([{ recordType: 'agreement-acceptance:rel-1', record: { ...accepted, release: { handle: 'terms-demo' } } }]);
    expect(releaseUrl('https://publishing.example', noSlug)).toBeNull();
  });

  it('recognises the record family by prefix', () => {
    expect(isAgreementRecordType('agreement-acceptance:rel-1')).toBe(true);
    expect(isAgreementRecordType('agreement-acceptance')).toBe(false);
    expect(isAgreementRecordType('impact-profile')).toBe(false);
  });
});
