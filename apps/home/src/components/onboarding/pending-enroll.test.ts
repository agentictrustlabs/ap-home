import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearPendingEnroll,
  enrollResumeHref,
  readPendingEnroll,
  writePendingEnroll,
  type PendingEnroll,
} from './pending-enroll';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear() { m.clear(); },
    getItem(k) { return m.get(k) ?? null; },
    key(i) { return [...m.keys()][i] ?? null; },
    removeItem(k) { m.delete(k); },
    setItem(k, v) { m.set(k, v); },
  };
}

const pending = (): PendingEnroll => ({
  popupMode: true,
  name: '',
  enroll: {
    aud: 'gather-app',
    redirectUri: 'https://gather27-web.richardpedersen3.workers.dev/',
    state: 'st',
    name: '',
    delegate: '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0',
    nonce: 'n',
    codeChallenge: 'challenge',
    template: 'site-login',
  },
});

beforeEach(() => {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { hostname: 'localhost' }, name: '' },
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: '' } });
});

afterEach(() => {
  clearPendingEnroll();
});

describe('pending enroll stash', () => {
  it('round-trips through sessionStorage', () => {
    writePendingEnroll(pending());
    const got = readPendingEnroll();
    expect(got?.enroll.aud).toBe('gather-app');
    expect(got?.popupMode).toBe(true);
  });

  it('refuses a stash that cannot authorize', () => {
    writePendingEnroll({
      popupMode: true,
      name: '',
      enroll: { aud: 'gather-app' } as PendingEnroll['enroll'],
    });
    expect(readPendingEnroll()).toBeNull();
  });

  it('rebuilds the authorize URL so consent can run after a `/` hop', () => {
    const href = enrollResumeHref(pending());
    expect(href).toContain('client_id=gather-app');
    expect(href).toContain('mode=popup');
    expect(href).toContain('code_challenge=challenge');
  });

  it('carries org-create purpose and existing org across the hop', () => {
    const href = enrollResumeHref({
      ...pending(),
      enroll: {
        ...pending().enroll,
        template: 'org-create',
        purpose: 'gather:host',
        existingOrg: '0x1111111111111111111111111111111111111111',
      },
    });
    expect(href).toContain('org_purpose=gather%3Ahost');
    expect(href).toContain('existing_org=0x1111111111111111111111111111111111111111');
  });
});
