import { describe, expect, it, vi } from 'vitest';
import { credentialMethodsFromEnv, whitelabel } from './config';

const DEFAULT = ['google', 'email'] as const;

describe('credentialMethodsFromEnv — the front door is an estate decision', () => {
  it('unset or blank keeps the default, in order', () => {
    expect(credentialMethodsFromEnv(undefined, DEFAULT)).toEqual([...DEFAULT]);
    expect(credentialMethodsFromEnv('', DEFAULT)).toEqual([...DEFAULT]);
    expect(credentialMethodsFromEnv(' , ', DEFAULT)).toEqual([...DEFAULT]);
  });

  it('a valid list is used verbatim, in the order given', () => {
    expect(credentialMethodsFromEnv('email', DEFAULT)).toEqual(['email']);
    expect(credentialMethodsFromEnv('email,google', DEFAULT)).toEqual(['email', 'google']);
    expect(credentialMethodsFromEnv('google, youversion ,email', DEFAULT)).toEqual(['google', 'youversion', 'email']);
  });

  it('is case-insensitive and de-duplicates', () => {
    expect(credentialMethodsFromEnv('Email,EMAIL,google', DEFAULT)).toEqual(['email', 'google']);
  });

  it('drops an entry that is not a method, with a warning, and keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(credentialMethodsFromEnv('email,gogle', DEFAULT)).toEqual(['email']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"gogle"');
    warn.mockRestore();
  });

  it('falls back to the default when nothing valid remains — a typo never yields a Home with no way in', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(credentialMethodsFromEnv('gogle', DEFAULT)).toEqual([...DEFAULT]);
    warn.mockRestore();
  });

  it('the deployment default is Google · email when the variable is not set in the test environment', () => {
    // named-home-door.test.ts asserts the same thing from the door's side; this pins the source.
    if (!process.env.NEXT_PUBLIC_CREDENTIAL_METHODS) expect(whitelabel.onboarding.credentialMethods).toEqual([...DEFAULT]);
  });
});
