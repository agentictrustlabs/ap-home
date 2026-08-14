import { describe, it, expect } from 'vitest';
import {
  formatLocation,
  hydrateLocationFields,
  locationFieldFilled,
  normalizeLocation,
  persistLocationFields,
  precisionAtLeast,
  projectLocationForShare,
} from './profile-location';

describe('normalizeLocation', () => {
  it('returns undefined without a country', () => {
    expect(normalizeLocation({ precision: 'city' as never, locality: 'Austin' })).toBeUndefined();
    expect(normalizeLocation(undefined, '', 'Austin')).toBeUndefined();
  });

  it('migrates legacy country/city into a locality location', () => {
    expect(normalizeLocation(undefined, 'United States', 'Austin')).toEqual({
      precision: 'locality',
      country: 'United States',
      locality: 'Austin',
    });
  });

  it('drops street fields when precision is country', () => {
    expect(normalizeLocation({
      precision: 'country',
      country: 'Canada',
      region: 'Ontario',
      locality: 'Toronto',
      street: '1 King St',
      postalCode: 'M5C 1A1',
    })).toEqual({ precision: 'country', country: 'Canada' });
  });

  it('infers precision from the finest filled field', () => {
    expect(normalizeLocation({ country: 'France', region: 'Île-de-France' })?.precision).toBe('region');
    expect(normalizeLocation({ country: 'France', street: '1 Rue de Rivoli' })?.precision).toBe('address');
  });
});

describe('formatLocation', () => {
  it('formats only up to the chosen precision', () => {
    expect(formatLocation({
      precision: 'region',
      country: 'Canada',
      region: 'Ontario',
      locality: 'Toronto',
      street: '1 King St',
    })).toBe('Ontario, Canada');
  });

  it('includes street, line2, and postal code at address precision', () => {
    expect(formatLocation({
      precision: 'address',
      country: 'United States',
      region: 'California',
      locality: 'Oakland',
      street: '100 Broadway',
      line2: 'Apt 4',
      postalCode: '94607',
    })).toBe('100 Broadway, Apt 4, Oakland, California, United States, 94607');
  });
});

describe('projectLocationForShare', () => {
  it('never leaks a street when precision is city', () => {
    expect(projectLocationForShare({
      precision: 'locality',
      country: 'United States',
      region: 'Texas',
      locality: 'Austin',
      street: '123 Secret Ln',
    })).toEqual({
      precision: 'locality',
      country: 'United States',
      region: 'Texas',
      locality: 'Austin',
      formatted: 'Austin, Texas, United States',
    });
  });
});

describe('precisionAtLeast', () => {
  it('orders country < region < locality < address', () => {
    expect(precisionAtLeast('address', 'locality')).toBe(true);
    expect(precisionAtLeast('country', 'region')).toBe(false);
    expect(precisionAtLeast('region', 'country')).toBe(true);
  });
});

describe('hydrateLocationFields / persistLocationFields', () => {
  it('lifts legacy country/city into a structured location', () => {
    const h = hydrateLocationFields({ country: 'Canada', city: 'Toronto' });
    expect(h.location).toEqual({ precision: 'locality', country: 'Canada', locality: 'Toronto' });
    expect(h.country).toBe('Canada');
    expect(h.city).toBe('Toronto');
  });

  it('clears legacy city when the person shares only a country', () => {
    const p = persistLocationFields({
      country: 'Canada',
      city: 'Toronto',
      location: { precision: 'country' as const, country: 'Canada', locality: 'Toronto' },
    });
    expect(p.location).toEqual({ precision: 'country', country: 'Canada' });
    expect(p.country).toBe('Canada');
    expect(p.city).toBeUndefined();
  });
});

describe('locationFieldFilled', () => {
  it('treats location as filled once a country is set', () => {
    expect(locationFieldFilled({ location: { precision: 'country', country: 'France' } }, 'location')).toBe(true);
    expect(locationFieldFilled({ country: 'France' }, 'location')).toBe(true);
    expect(locationFieldFilled({}, 'location')).toBe(false);
  });

  it('treats city as filled only at city-or-finer precision', () => {
    expect(locationFieldFilled({
      location: { precision: 'country', country: 'France', locality: 'Paris' },
    }, 'city')).toBe(false);
    expect(locationFieldFilled({
      location: { precision: 'locality', country: 'France', locality: 'Paris' },
    }, 'city')).toBe(true);
  });
});
