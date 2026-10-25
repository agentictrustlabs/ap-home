import { describe, it, expect } from 'vitest';
import { thenStep } from './useEnrollReq';

describe('the step a sign-in window takes next', () => {
  const A = '0x' + 'ab'.repeat(20);
  it('is one friend act on Contacts that an app names', () => {
    expect(thenStep(`/contacts?add=${A}&from=seed-reader&name=Ruth`)).toBe(`/contacts?add=${A}&from=seed-reader&name=Ruth`);
    expect(thenStep(`/contacts?remove=${A}&from=seed-reader`)).toBe(`/contacts?remove=${A}&from=seed-reader`);
  });
  it('is nothing else: another page, another site, no app, or no address', () => {
    expect(thenStep(null)).toBeUndefined();
    expect(thenStep(`/settings?add=${A}&from=x`)).toBeUndefined();
    expect(thenStep(`https://evil.example/contacts?add=${A}&from=x`)).toBeUndefined();
    expect(thenStep(`//evil.example/contacts?add=${A}&from=x`)).toBeUndefined();
    expect(thenStep(`/contacts?add=${A}`)).toBeUndefined();
    expect(thenStep('/contacts?add=ruth.me&from=seed-reader')).toBeUndefined();
  });
});
