/**
 * The organization's common name on the wire — what is stored on the link, and what an app is given.
 *
 * WHAT THESE PIN: `displayName` reaches a relying app only when it says something `orgName` does not
 * (the creation ceremonies seed the profile with the naming-service name itself), and `website` only
 * when it is a link an app can safely render.
 */
import { describe, it, expect } from 'vitest';

import { orgCommonNameFields, sanitizeOrgProfileProjection } from './org-profile';

describe('sanitizeOrgProfileProjection', () => {
  it('keeps a trimmed display name and an http(s) website', () => {
    expect(sanitizeOrgProfileProjection({ displayName: '  Global.Church ', website: 'https://global.church' })).toEqual({
      displayName: 'Global.Church',
      website: 'https://global.church',
    });
  });

  it('carries only the two projected fields — the rest of org.profile stays in the vault', () => {
    expect(sanitizeOrgProfileProjection({ v: 1, displayName: 'Grace', description: 'd', contactEmail: 'a@b.c', location: 'x' })).toEqual({ displayName: 'Grace' });
  });

  it('caps the display name at 80 characters', () => {
    expect(sanitizeOrgProfileProjection({ displayName: 'x'.repeat(200) }).displayName).toHaveLength(80);
  });

  it('drops a website that is not an http(s) URL', () => {
    for (const website of ['javascript:alert(1)', 'global.church', 'mailto:a@b.c', `https://x.org/${'a'.repeat(200)}`]) {
      expect(sanitizeOrgProfileProjection({ displayName: 'Grace', website })).toEqual({ displayName: 'Grace' });
    }
  });

  it('is empty for a cleared or malformed profile', () => {
    expect(sanitizeOrgProfileProjection({ displayName: '   ', website: '' })).toEqual({});
    expect(sanitizeOrgProfileProjection(null)).toEqual({});
    expect(sanitizeOrgProfileProjection('Grace')).toEqual({});
    expect(sanitizeOrgProfileProjection({ displayName: 7 })).toEqual({});
  });
});

describe('orgCommonNameFields', () => {
  it('returns the common name beside the naming-service name', () => {
    expect(orgCommonNameFields('global-church.org', { displayName: 'Global.Church', website: 'https://global.church' })).toEqual({
      displayName: 'Global.Church',
      website: 'https://global.church',
    });
  });

  /*
    THE SEEDED PROFILE. Creation writes `displayName` = the name the organization was created under,
    so an unedited profile repeats `orgName` (or its label). That is not a common name.
  */
  it('omits a display name that only repeats the naming-service name or its label', () => {
    expect(orgCommonNameFields('global-church.org', { displayName: 'global-church.org' })).toEqual({});
    expect(orgCommonNameFields('global-church.org', { displayName: 'Global-Church.ORG' })).toEqual({});
    expect(orgCommonNameFields('global-church.org', { displayName: 'global-church' })).toEqual({});
  });

  it('still returns the website when the display name adds nothing', () => {
    expect(orgCommonNameFields('global-church.org', { displayName: 'global-church.org', website: 'https://global.church' })).toEqual({
      website: 'https://global.church',
    });
  });

  it('returns nothing for a link that carries no projection', () => {
    expect(orgCommonNameFields('global-church.org', undefined)).toEqual({});
    expect(orgCommonNameFields('global-church.org', {})).toEqual({});
  });

  it('returns the display name when the link has no naming-service name to compare with', () => {
    expect(orgCommonNameFields('', { displayName: 'Grace Community Church' })).toEqual({ displayName: 'Grace Community Church' });
  });
});
