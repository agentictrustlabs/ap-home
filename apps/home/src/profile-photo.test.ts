import { describe, it, expect } from 'vitest';
import { isProfilePhoto, MAX_PHOTO_CHARS } from './profile-store';

describe('a profile photo', () => {
  it('is an inline image the avatar maker produces', () => {
    expect(isProfilePhoto('data:image/jpeg;base64,/9j/4AAQSkZJRg==')).toBe(true);
    expect(isProfilePhoto('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
  });
  it('is never a link, another type, script, or an oversized original', () => {
    expect(isProfilePhoto('https://example.com/me.jpg')).toBe(false);
    expect(isProfilePhoto('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isProfilePhoto('data:text/html;base64,PGI+')).toBe(false);
    expect(isProfilePhoto(`data:image/jpeg;base64,${'A'.repeat(MAX_PHOTO_CHARS)}`)).toBe(false);
    expect(isProfilePhoto(undefined)).toBe(false);
  });
});
