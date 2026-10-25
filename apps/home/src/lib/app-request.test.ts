import { describe, it, expect } from 'vitest';
import { appRequestOf } from './app-request';

describe('an app\'s one request', () => {
  it('is a friend act on Contacts named by an app, with the friend as the app named them', () => {
    expect(appRequestOf({ pathname: '/contacts', search: '?add=0xabc&from=seed-reader&name=Ruth' })).toEqual({ act: 'add', name: 'Ruth', from: 'seed-reader' });
    expect(appRequestOf({ pathname: '/contacts', search: '?remove=0xabc&from=seed-reader' })).toEqual({ act: 'remove', name: null, from: 'seed-reader' });
  });
  it('is nothing without an app, without an act, or elsewhere', () => {
    expect(appRequestOf({ pathname: '/contacts', search: '?add=0xabc' })).toBeNull();
    expect(appRequestOf({ pathname: '/contacts', search: '?from=seed-reader' })).toBeNull();
    expect(appRequestOf({ pathname: '/', search: '?add=0xabc&from=seed-reader' })).toBeNull();
  });
});
