import { describe, expect, it } from 'vitest';
import { socialButtonsForNamedHome } from './named-home-door';
import { whitelabel } from '../whitelabel/config';

const FAITHNET = ['google', 'email'] as const;

describe('a named home door offers only the social ways in this deployment opens', () => {
  it('the deployment default is Google · email (no YouVersion)', () => {
    expect(whitelabel.onboarding.credentialMethods).toEqual([...FAITHNET]);
  });

  it('unpublished kind + EOA custodian (the faithnet fallback) → Google only, secondary', () => {
    expect(socialButtonsForNamedHome({ connectionKind: null, hasEoa: true, hasPasskey: false, methods: FAITHNET }))
      .toEqual([{ provider: 'google', primary: false }]);
  });

  it('the fallback grows YouVersion only when the deployment opens it', () => {
    expect(socialButtonsForNamedHome({ connectionKind: undefined, hasEoa: true, hasPasskey: false, methods: ['google', 'youversion', 'email'] }))
      .toEqual([{ provider: 'youversion', primary: false }, { provider: 'google', primary: false }]);
  });

  it('a home whose PUBLISHED kind is youversion keeps its button even where the door is closed to new members', () => {
    expect(socialButtonsForNamedHome({ connectionKind: 'youversion', hasEoa: true, hasPasskey: false, methods: FAITHNET }))
      .toEqual([{ provider: 'youversion', primary: true }]);
  });

  it('a google-custodied home gets Google as primary', () => {
    expect(socialButtonsForNamedHome({ connectionKind: 'google', hasEoa: true, hasPasskey: false, methods: FAITHNET }))
      .toEqual([{ provider: 'google', primary: true }]);
  });

  it('email/phone-custodied and passkey homes get no social fallback', () => {
    expect(socialButtonsForNamedHome({ connectionKind: 'email', hasEoa: true, hasPasskey: false, methods: FAITHNET })).toEqual([]);
    expect(socialButtonsForNamedHome({ connectionKind: null, hasEoa: true, hasPasskey: true, methods: FAITHNET })).toEqual([]);
    expect(socialButtonsForNamedHome({ connectionKind: null, hasEoa: false, hasPasskey: false, methods: FAITHNET })).toEqual([]);
  });
});
