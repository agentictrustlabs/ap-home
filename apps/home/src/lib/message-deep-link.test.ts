import { describe, expect, it } from 'vitest';
import { DEEP_LINK_TEXT_MAX, parseMessageDeepLink, sanitizeDeepLinkText } from './message-deep-link';

describe('messages deep link ?to=&text=', () => {
  it('absent: no to, no link', () => {
    expect(parseMessageDeepLink('')).toBeNull();
    expect(parseMessageDeepLink('?to=%20%20')).toBeNull();
  });

  it('to alone opens compose with no seeded text', () => {
    expect(parseMessageDeepLink('?to=Cil-Commons-1e07.org')).toEqual({ to: 'cil-commons-1e07.org', text: null });
    expect(parseMessageDeepLink('?to=alice&text=%20%20')).toEqual({ to: 'alice', text: null });
  });

  it('valid: to + text seeds the trimmed words', () => {
    const q = new URLSearchParams({ to: '0xAbC0000000000000000000000000000000000001', text: '  Propose a skill:\nweekly report  ' });
    expect(parseMessageDeepLink(q)).toEqual({ to: '0xabc0000000000000000000000000000000000001', text: 'Propose a skill:\nweekly report' });
  });

  it('text without to is ignored', () => {
    expect(parseMessageDeepLink('?text=hello')).toBeNull();
  });

  it('too long: cut to the cap, ending in an ellipsis', () => {
    const out = sanitizeDeepLinkText('a'.repeat(DEEP_LINK_TEXT_MAX + 50));
    expect(Array.from(out)).toHaveLength(DEEP_LINK_TEXT_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(sanitizeDeepLinkText('b'.repeat(DEEP_LINK_TEXT_MAX))).toBe('b'.repeat(DEEP_LINK_TEXT_MAX));
    // a cut never splits a surrogate pair
    const emoji = sanitizeDeepLinkText('😀'.repeat(DEEP_LINK_TEXT_MAX + 1));
    expect(Array.from(emoji)).toHaveLength(DEEP_LINK_TEXT_MAX);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('control characters are stripped; newlines and tabs kept', () => {
    expect(sanitizeDeepLinkText('a\u0000b\u0007c\u001Bd\u007Fe\u0085f')).toBe('abcdef');
    expect(sanitizeDeepLinkText('safe‮txt.exe⁦x⁩')).toBe('safetxt.exex');
    expect(sanitizeDeepLinkText('line one\r\nline\ttwo\rthree')).toBe('line one\nline\ttwo\nthree');
    expect(parseMessageDeepLink('?to=bob&text=%00%01%02')).toEqual({ to: 'bob', text: null });
  });
});
