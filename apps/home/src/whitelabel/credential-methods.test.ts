import { describe, expect, it } from 'vitest';

import { credentialMethods } from './config';

describe('credentialMethods (NEXT_PUBLIC_CREDENTIAL_METHODS)', () => {
  const DEFAULT = ['google', 'email'] as const;
  it('keeps the default when unset or empty', () => {
    expect(credentialMethods(undefined, DEFAULT)).toEqual(['google', 'email']);
    expect(credentialMethods('  ', DEFAULT)).toEqual(['google', 'email']);
  });
  it('drops Google for a Home whose Google client is not set up', () => {
    expect(credentialMethods('email', DEFAULT)).toEqual(['email']);
  });
  it('ignores unknown entries, trims, and de-duplicates', () => {
    expect(credentialMethods(' email , bogus,email,passkey', DEFAULT)).toEqual(['email', 'passkey']);
  });
  it('falls back to the default when nothing named is known', () => {
    expect(credentialMethods('bogus', DEFAULT)).toEqual(['google', 'email']);
  });
});
