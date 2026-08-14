'use client';

import {
  LOCATION_PRECISIONS,
  LOCATION_PRECISION_LABEL,
  formatLocation,
  precisionAtLeast,
  type LocationPrecision,
  type ProfileLocation,
} from '../../../lib/profile-location';

export function LocationFields({
  value,
  onChange,
  required,
  appLabel,
  missing,
}: {
  value: ProfileLocation | undefined;
  onChange: (next: ProfileLocation) => void;
  required?: boolean;
  appLabel?: string;
  missing?: boolean;
}) {
  const precision: LocationPrecision = value?.precision ?? 'country';
  const loc: ProfileLocation = { precision, ...value };

  function set<K extends keyof ProfileLocation>(key: K, v: ProfileLocation[K]) {
    onChange({ ...loc, [key]: v });
  }

  const preview = formatLocation(loc);

  return (
    <div className={`settings-field settings-location${required ? ' settings-field--required' : ''}`}>
      <label>
        Location
        {required && appLabel && (
          <span style={{ marginLeft: '0.4rem', fontSize: '0.65rem', fontWeight: 700, color: 'var(--color-amber-700)' }}>
            required by {appLabel}
          </span>
        )}
      </label>
      <div className="settings-field__help" style={{ marginBottom: '0.35rem' }}>
        Choose how precisely apps may see where you are. They never receive more than this.
      </div>
      <div className="settings-location-precision" role="radiogroup" aria-label="Location precision">
        {LOCATION_PRECISIONS.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={precision === p}
            className={`settings-location-precision__opt${precision === p ? ' is-active' : ''}`}
            onClick={() => set('precision', p)}
          >
            {LOCATION_PRECISION_LABEL[p]}
          </button>
        ))}
      </div>

      <label htmlFor="profile-location-country">Country</label>
      <input
        id="profile-location-country"
        type="text"
        value={loc.country ?? ''}
        onChange={(e) => set('country', e.target.value)}
        placeholder="United States"
        autoComplete="country-name"
        style={missing ? { borderColor: 'var(--color-danger)' } : undefined}
      />

      {precisionAtLeast(precision, 'region') && (
        <>
          <label htmlFor="profile-location-region">State / province</label>
          <input
            id="profile-location-region"
            type="text"
            value={loc.region ?? ''}
            onChange={(e) => set('region', e.target.value)}
            placeholder="California"
            autoComplete="address-level1"
          />
        </>
      )}

      {precisionAtLeast(precision, 'locality') && (
        <>
          <label htmlFor="profile-location-locality">City</label>
          <input
            id="profile-location-locality"
            type="text"
            value={loc.locality ?? ''}
            onChange={(e) => set('locality', e.target.value)}
            placeholder="Oakland"
            autoComplete="address-level2"
          />
        </>
      )}

      {precisionAtLeast(precision, 'address') && (
        <>
          <label htmlFor="profile-location-street">Street address</label>
          <input
            id="profile-location-street"
            type="text"
            value={loc.street ?? ''}
            onChange={(e) => set('street', e.target.value)}
            placeholder="100 Broadway"
            autoComplete="street-address"
          />
          <label htmlFor="profile-location-line2">Apt / suite (optional)</label>
          <input
            id="profile-location-line2"
            type="text"
            value={loc.line2 ?? ''}
            onChange={(e) => set('line2', e.target.value)}
            placeholder="Apt 4"
            autoComplete="address-line2"
          />
          <label htmlFor="profile-location-postal">Postal code</label>
          <input
            id="profile-location-postal"
            type="text"
            value={loc.postalCode ?? ''}
            onChange={(e) => set('postalCode', e.target.value)}
            placeholder="94607"
            autoComplete="postal-code"
          />
        </>
      )}

      {preview && (
        <div className="settings-location-preview">
          Apps will see: <strong>{preview}</strong>
        </div>
      )}
    </div>
  );
}
