/** Private community-profile location. Vault PII — never a public `approf:` / on-chain facet. */

export const LOCATION_PRECISIONS = ['country', 'region', 'locality', 'address'] as const;
export type LocationPrecision = (typeof LOCATION_PRECISIONS)[number];

export const LOCATION_PRECISION_LABEL: Record<LocationPrecision, string> = {
  country: 'Country',
  region: 'State / province',
  locality: 'City',
  address: 'Street address',
};

export interface ProfileLocation {
  precision: LocationPrecision;
  country?: string;
  /** State, province, or equivalent administrative region. */
  region?: string;
  /** City, town, or equivalent locality. */
  locality?: string;
  street?: string;
  line2?: string;
  postalCode?: string;
}

const ORDER: readonly LocationPrecision[] = LOCATION_PRECISIONS;

export function isLocationPrecision(v: unknown): v is LocationPrecision {
  return typeof v === 'string' && (LOCATION_PRECISIONS as readonly string[]).includes(v);
}

export function precisionAtLeast(have: LocationPrecision, need: LocationPrecision): boolean {
  return ORDER.indexOf(have) >= ORDER.indexOf(need);
}

function inferPrecision(loc: Partial<ProfileLocation>): LocationPrecision {
  if (loc.street || loc.line2 || loc.postalCode) return 'address';
  if (loc.locality) return 'locality';
  if (loc.region) return 'region';
  return 'country';
}

function trim(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** Normalize a location and drop fields finer than the chosen precision. */
export function normalizeLocation(
  location?: Partial<ProfileLocation> | null,
  legacyCountry?: string,
  legacyCity?: string,
): ProfileLocation | undefined {
  const raw: Partial<ProfileLocation> = location ? { ...location } : {};
  if (!trim(raw.country) && trim(legacyCountry)) raw.country = legacyCountry;
  if (!trim(raw.locality) && trim(legacyCity)) raw.locality = legacyCity;
  const country = trim(raw.country);
  if (!country) return undefined;
  const precision = isLocationPrecision(raw.precision) ? raw.precision : inferPrecision(raw);
  const out: ProfileLocation = { precision, country };
  if (precisionAtLeast(precision, 'region')) {
    const region = trim(raw.region);
    if (region) out.region = region;
  }
  if (precisionAtLeast(precision, 'locality')) {
    const locality = trim(raw.locality);
    if (locality) out.locality = locality;
  }
  if (precisionAtLeast(precision, 'address')) {
    const street = trim(raw.street);
    const line2 = trim(raw.line2);
    const postalCode = trim(raw.postalCode);
    if (street) out.street = street;
    if (line2) out.line2 = line2;
    if (postalCode) out.postalCode = postalCode;
  }
  return out;
}

export function formatLocation(loc?: ProfileLocation | null): string {
  if (!loc?.country) return '';
  const parts: string[] = [];
  if (precisionAtLeast(loc.precision, 'address')) {
    if (loc.street) parts.push(loc.street);
    if (loc.line2) parts.push(loc.line2);
  }
  if (precisionAtLeast(loc.precision, 'locality') && loc.locality) parts.push(loc.locality);
  if (precisionAtLeast(loc.precision, 'region') && loc.region) parts.push(loc.region);
  parts.push(loc.country);
  if (precisionAtLeast(loc.precision, 'address') && loc.postalCode) parts.push(loc.postalCode);
  return parts.join(', ');
}

export interface LocationContactFields {
  location?: ProfileLocation;
  country?: string;
  city?: string;
}

export function hydrateLocationFields<T extends LocationContactFields>(contact: T): T & LocationContactFields {
  const location = normalizeLocation(contact.location, contact.country, contact.city);
  if (!location) return { ...contact };
  return persistLocationFields({ ...contact, location });
}

export function persistLocationFields<T extends LocationContactFields>(contact: T): T {
  const location = normalizeLocation(contact.location, contact.country, contact.city);
  const next = { ...contact };
  if (!location) {
    delete next.location;
    return next;
  }
  next.location = location;
  next.country = location.country;
  if (precisionAtLeast(location.precision, 'locality') && location.locality) next.city = location.locality;
  else delete next.city;
  return next;
}

export function locationFieldFilled(contact: LocationContactFields, key: 'location' | 'country' | 'city'): boolean {
  if (key === 'location') return Boolean(normalizeLocation(contact.location, contact.country, contact.city)?.country);
  if (key === 'country') return Boolean((contact.location?.country ?? contact.country ?? '').trim());
  const loc = normalizeLocation(contact.location, contact.country, contact.city);
  return Boolean(loc && precisionAtLeast(loc.precision, 'locality') && loc.locality);
}

export function locationFieldValue(contact: LocationContactFields, key: 'location' | 'country' | 'city'): string {
  if (key === 'location') return formatLocation(normalizeLocation(contact.location, contact.country, contact.city));
  if (key === 'country') return (contact.location?.country ?? contact.country ?? '').trim();
  const loc = normalizeLocation(contact.location, contact.country, contact.city);
  return loc && precisionAtLeast(loc.precision, 'locality') ? (loc.locality ?? '').trim() : '';
}

/** Fields an app may receive — never finer than the person's chosen precision. */
export function projectLocationForShare(loc?: ProfileLocation | null): {
  precision?: LocationPrecision;
  country?: string;
  region?: string;
  locality?: string;
  street?: string;
  line2?: string;
  postalCode?: string;
  formatted?: string;
} {
  const n = normalizeLocation(loc);
  if (!n) return {};
  const out: ReturnType<typeof projectLocationForShare> = { precision: n.precision, country: n.country };
  if (precisionAtLeast(n.precision, 'region') && n.region) out.region = n.region;
  if (precisionAtLeast(n.precision, 'locality') && n.locality) out.locality = n.locality;
  if (precisionAtLeast(n.precision, 'address')) {
    if (n.street) out.street = n.street;
    if (n.line2) out.line2 = n.line2;
    if (n.postalCode) out.postalCode = n.postalCode;
  }
  const formatted = formatLocation(n);
  if (formatted) out.formatted = formatted;
  return out;
}
