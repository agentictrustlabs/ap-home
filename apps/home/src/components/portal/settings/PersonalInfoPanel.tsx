'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Address } from '@agenticprimitives/types';
import {
  loadImpactProfile,
  saveImpactProfile,
  PROFILE_FIELDS,
  VaultKeyUnauthorizedError,
  type ImpactStoredProfile,
  type ImpactContactProfile,
  type ImpactProfileFieldKey,
} from '../../../profile-store';

export function PersonalInfoPanel({
  agentAddress,
  requiredKeys,
  appLabel,
  onSaved,
  onNeedsVaultKey,
}: {
  agentAddress: Address | null;
  /** Relying-app handoff: highlight required fields */
  requiredKeys?: ImpactProfileFieldKey[];
  appLabel?: string;
  onSaved?: (contact: ImpactContactProfile) => void;
  onNeedsVaultKey?: () => void;
}) {
  const [stored, setStored] = useState<ImpactStoredProfile | null>(null);
  const [contact, setContact] = useState<ImpactContactProfile>({});
  const [loading, setLoading] = useState(true);
  const [needsVaultKey, setNeedsVaultKey] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const required = useMemo(() => new Set(requiredKeys ?? []), [requiredKeys]);
  const missingRequired = useMemo(
    () => (requiredKeys ?? []).filter((k) => !(contact[k] ?? '').trim()),
    [requiredKeys, contact],
  );

  useEffect(() => {
    if (!agentAddress) return;
    let cancelled = false;
    setLoading(true);
    setNeedsVaultKey(false);
    setLoadError(null);
    loadImpactProfile(agentAddress)
      .then((p) => {
        if (cancelled) return;
        setStored(p);
        setContact(p.contact ?? {});
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof VaultKeyUnauthorizedError) {
          setNeedsVaultKey(true);
          onNeedsVaultKey?.();
        } else {
          setLoadError('Could not load your profile from your encrypted vault.');
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [agentAddress, onNeedsVaultKey]);

  function handleChange(key: ImpactProfileFieldKey, v: string) {
    setContact((c) => ({ ...c, [key]: v }));
    setSavedNotice(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!agentAddress || missingRequired.length > 0) return;
    setSubmitting(true);
    setSavedNotice(null);
    setLoadError(null);
    try {
      const next: ImpactStoredProfile = { v: 1, contact, attestations: stored?.attestations };
      await saveImpactProfile(agentAddress, next);
      setStored(next);
      setSavedNotice('Saved to your encrypted vault');
      onSaved?.(contact);
    } catch (err) {
      if (err instanceof VaultKeyUnauthorizedError) {
        setNeedsVaultKey(true);
        onNeedsVaultKey?.();
      } else {
        setLoadError('Could not save to your encrypted vault.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="settings-banner settings-banner--warn">Loading from your encrypted vault…</div>;
  }

  if (needsVaultKey) {
    return (
      <div className="settings-banner settings-banner--info">
        <div>
          <strong>Activate your vault key</strong>
          <p style={{ margin: '0.35rem 0 0', fontSize: '0.82rem' }}>
            Contact details live in your private vault — activate your key once to view and edit them.
          </p>
          <a href="/vault-key" className="btn-primary" style={{ display: 'inline-flex', width: 'auto', marginTop: '0.65rem', textDecoration: 'none' }}>
            Activate vault key →
          </a>
        </div>
      </div>
    );
  }

  return (
    <form className="settings-form" onSubmit={(e) => void handleSubmit(e)}>
      {loadError && <div className="settings-banner settings-banner--error" role="alert">{loadError}</div>}
      {savedNotice && <div className="settings-banner settings-banner--success" role="status">✓ {savedNotice}</div>}

      {PROFILE_FIELDS.map((f) => {
        const isRequired = required.has(f.key);
        const missing = isRequired && !(contact[f.key] ?? '').trim();
        return (
          <div key={f.key} className={`settings-field${isRequired ? ' settings-field--required' : ''}`}>
            <label htmlFor={`profile-${f.key}`}>
              {f.label}
              {isRequired && appLabel && (
                <span style={{ marginLeft: '0.4rem', fontSize: '0.65rem', fontWeight: 700, color: 'var(--color-amber-700)' }}>
                  required by {appLabel}
                </span>
              )}
            </label>
            <input
              id={`profile-${f.key}`}
              type={f.type}
              value={contact[f.key] ?? ''}
              onChange={(e) => handleChange(f.key, e.target.value)}
              placeholder={f.placeholder}
              autoComplete={autoCompleteFor(f.key)}
              style={missing ? { borderColor: 'var(--color-danger)' } : undefined}
            />
            <div className="settings-field__help">{f.help}</div>
          </div>
        );
      })}

      <div className="settings-form-footer">
        <button type="submit" className="btn-primary" style={{ width: 'auto' }} disabled={submitting || missingRequired.length > 0}>
          {submitting ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function autoCompleteFor(k: ImpactProfileFieldKey): string {
  switch (k) {
    case 'firstName': return 'given-name';
    case 'lastName': return 'family-name';
    case 'email': return 'email';
    case 'phone': return 'tel';
    case 'country': return 'country-name';
    case 'city': return 'address-level2';
    case 'organizationName': return 'organization';
    case 'organizationCountry': return 'country-name';
  }
}
