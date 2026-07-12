'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Address } from '@agenticprimitives/types';
import {
  loadImpactProfile,
  saveImpactProfile,
  PROFILE_FIELDS,
  VaultKeyUnauthorizedError,
  InteractionsNotEnabledError,
  type ImpactStoredProfile,
  type ImpactContactProfile,
  type ImpactProfileFieldKey,
} from '../../../profile-store';
import { useSession } from '../../../context/session';
import { activateInteractionsIfNeeded, resolveVia, isKmsVia } from '../../../home/onboarding';
import { BusyButton } from '../../shared/BusyButton';

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
  const { session, profile: homeProfile } = useSession();
  const [stored, setStored] = useState<ImpactStoredProfile | null>(null);
  const [contact, setContact] = useState<ImpactContactProfile>({});
  const [loading, setLoading] = useState(true);
  const [needsVaultKey, setNeedsVaultKey] = useState(false);
  const [needsInteractions, setNeedsInteractions] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const required = useMemo(() => new Set(requiredKeys ?? []), [requiredKeys]);
  const missingRequired = useMemo(
    () => (requiredKeys ?? []).filter((k) => !(contact[k] ?? '').trim()),
    [requiredKeys, contact],
  );

  // Enable the person's INTERACTIONS plane (distinct from the vault key). Returns true on success.
  // Silent on KMS homes (server-signed); wallet/passkey need a user gesture, so callers that aren't
  // already inside a click gate on isKmsVia before calling this to avoid a blocked popup.
  const enableInteractions = useCallback(async (): Promise<boolean> => {
    if (!agentAddress) return false;
    const via = resolveVia(homeProfile?.credential, session?.via);
    const auth = session?.token ? { token: session.token } : undefined;
    try { return (await activateInteractionsIfNeeded(agentAddress, via, auth)).ok; }
    catch { return false; }
  }, [agentAddress, homeProfile?.credential, session?.via, session?.token]);

  const load = useCallback(async (autoEnable: boolean): Promise<void> => {
    if (!agentAddress) return;
    setLoading(true); setNeedsVaultKey(false); setNeedsInteractions(false); setLoadError(null);
    try {
      const p = await loadImpactProfile(agentAddress);
      setStored(p); setContact(p.contact ?? {});
    } catch (err) {
      if (err instanceof VaultKeyUnauthorizedError) { setNeedsVaultKey(true); onNeedsVaultKey?.(); }
      else if (err instanceof InteractionsNotEnabledError) {
        // Self-heal: users onboarded before the interactions plane (spec 322) have no interactions
        // grant. On a KMS home we enable it SILENTLY (server-signed) and reload — no ceremony, no
        // wrong "activate vault key". Wallet/passkey need a user gesture → show the Enable button.
        const via = resolveVia(homeProfile?.credential, session?.via);
        if (autoEnable && isKmsVia(via) && session?.token && (await enableInteractions())) {
          const p = await loadImpactProfile(agentAddress);
          setStored(p); setContact(p.contact ?? {});
        } else {
          setNeedsInteractions(true);
        }
      } else { setLoadError('Could not load your profile from your encrypted vault.'); }
    } finally { setLoading(false); }
  }, [agentAddress, homeProfile?.credential, session?.via, session?.token, onNeedsVaultKey, enableInteractions]);

  useEffect(() => { void load(true); }, [load]);

  // User-gesture enable (wallet/passkey): the click satisfies the WebAuthn/wallet activation requirement.
  const handleEnableInteractions = useCallback(async (): Promise<void> => {
    setEnabling(true); setLoadError(null);
    const ok = await enableInteractions();
    setEnabling(false);
    if (ok) { setNeedsInteractions(false); await load(false); }
    else setLoadError('Could not turn on your private storage — please try again.');
  }, [enableInteractions, load]);

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
      } else if (err instanceof InteractionsNotEnabledError) {
        // Plane not enabled → surface the Enable step (silent-enable happens on load; this is the
        // wallet/passkey gesture path or a race). The user enables, then saves again.
        setNeedsInteractions(true);
      } else {
        // Surface the REAL reason (incl. the read-back-verify failure) instead of a generic line, so
        // a save that silently didn't persist says exactly what happened.
        setLoadError(err instanceof Error ? err.message : 'Could not save to your encrypted vault.');
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

  if (needsInteractions) {
    return (
      <div className="settings-banner settings-banner--info">
        <div>
          <strong>Turn on your private storage</strong>
          <p style={{ margin: '0.35rem 0 0', fontSize: '0.82rem' }}>
            Your contact details live in your own encrypted space on your home. Enable it once — it takes a second and nothing leaves your control.
          </p>
          <BusyButton
            busy={enabling}
            busyLabel="Turning on…"
            className="btn-primary"
            style={{ width: 'auto', marginTop: '0.65rem' }}
            onClick={() => void handleEnableInteractions()}
          >
            Turn on storage
          </BusyButton>
          {loadError && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem', marginTop: '0.5rem' }}>{loadError}</p>}
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
