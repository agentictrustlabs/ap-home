import { describe, it, expect } from 'vitest';
import { rosterFromDirectoryResponse, filterRecipients } from './recipient-directory';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = '0xcccccccccccccccccccccccccccccccccccccccc';

describe('rosterFromDirectoryResponse', () => {
  it('keeps NAMELESS members, preferring the org-local name, and sorts by display name', () => {
    const rows = rosterFromDirectoryResponse({
      ok: true,
      listings: [
        { listing: { subject: `eip155:84532:${B.toUpperCase().replace('0X', '0x')}`, displayName: 'Zed Nameless', orgRole: 'volunteer' }, label: 'zed-nameless' },
        { listing: { subject: `eip155:84532:${A}`, displayName: 'Alice Named', localName: 'Ali', publicName: 'alice.impact' }, label: 'alice' },
        { listing: { displayName: 'No address' } },
        { listing: { subject: `eip155:84532:${C}` }, label: 'label-only' },
      ],
    });
    expect(rows.map((r) => r.displayName)).toEqual(['Ali', 'label-only', 'Zed Nameless']);
    expect(rows[0]).toMatchObject({ address: A, publicName: 'alice.impact' });
    expect(rows[2]).toMatchObject({ address: B, publicName: null, role: 'volunteer' });
  });
  it('dedupes a subject listed twice and falls back to a short address when nothing names them', () => {
    const rows = rosterFromDirectoryResponse({ listings: [{ listing: { subject: A } }, { listing: { subject: A, displayName: 'dup' } }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe('0xaaaa…aaaa');
  });
});

describe('filterRecipients', () => {
  const rows = [
    { address: A, title: 'Alice Named', subtitle: 'alice.impact' },
    { address: B, title: 'Zed Nameless' },
  ];
  it('matches title, subtitle or address, case-insensitively; empty returns all', () => {
    expect(filterRecipients(rows, '').map((r) => r.title)).toEqual(['Alice Named', 'Zed Nameless']);
    expect(filterRecipients(rows, 'IMPACT').map((r) => r.title)).toEqual(['Alice Named']);
    expect(filterRecipients(rows, 'zed').map((r) => r.title)).toEqual(['Zed Nameless']);
    expect(filterRecipients(rows, '0xbbbb').map((r) => r.title)).toEqual(['Zed Nameless']);
  });
});
