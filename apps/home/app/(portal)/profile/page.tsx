'use client';
// Profile editor — relying-app handoff (?app=&return=&state=&required=) or redirect to /you settings.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '../../../src/context/session';
import { relyingAllowed } from '../../../src/components/onboarding/useEnrollReq';
import { whitelabel } from '../../../src/whitelabel/config';
import type { ImpactProfileFieldKey, ImpactContactProfile } from '../../../src/profile-store';
import { SHAREABLE_PROFILE_KEYS, contactFieldValue, persistContact } from '../../../src/profile-store';
import { projectLocationForShare } from '../../../src/lib/profile-location';
import { PersonalInfoPanel } from '../../../src/components/portal/settings/PersonalInfoPanel';
import { SettingsLayout } from '../../../src/components/portal/settings/SettingsLayout';
import { ProfileHeader } from '../../../src/components/portal/settings/ProfileHeader';
import { UserIcon } from '../../../src/components/shared/Icons';

interface RelyingRequest {
  appId: string;
  appLabel: string;
  returnUrl: string;
  state: string;
  required: ImpactProfileFieldKey[];
}

function parseRelyingRequest(): RelyingRequest | null {
  if (typeof window === 'undefined') return null;
  const u = new URL(window.location.href);
  const app = u.searchParams.get('app');
  const returnUrl = u.searchParams.get('return');
  const state = u.searchParams.get('state');
  const required = u.searchParams.get('required');
  if (!app || !returnUrl || !state) return null;
  if (!relyingAllowed(returnUrl)) return null;
  const appConfig = whitelabel.relyingApps.find((a) => a.client_id === app);
  if (!appConfig) return null;
  if (!appConfig.redirect_uris.some((uri) => sameOrigin(uri, returnUrl))) return null;
  const requestedKeys = (required?.split(',') ?? [])
    .map((s) => s.trim())
    .filter((k): k is ImpactProfileFieldKey =>
      (SHAREABLE_PROFILE_KEYS as readonly string[]).includes(k),
    );
  return { appId: app, appLabel: appConfig.name ?? app, returnUrl, state, required: requestedKeys };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export default function ProfilePage() {
  const router = useRouter();
  const { agentAddress, agentName } = useSession();
  const [request, setRequest] = useState<RelyingRequest | null>(null);

  useEffect(() => {
    const req = parseRelyingRequest();
    if (req) setRequest(req);
    else router.replace('/you?tab=personal');
  }, [router]);

  const personLabel = agentName ?? 'your home';

  if (!request) {
    return (
      <div className="settings-banner settings-banner--warn" style={{ margin: '2rem auto', maxWidth: 480 }}>
        Redirecting to My Profile…
      </div>
    );
  }

  return (
    <SettingsLayout
      tabs={[{ id: 'edit', label: 'Edit profile' }]}
      active="edit"
      onSelect={() => {}}
      title="Your profile"
      description={`${request.appLabel} needs these fields — saved at ${personLabel}, then you return to their site.`}
      header={
        <ProfileHeader
          name={agentName ?? 'Your profile'}
          handle={agentName ? `@${agentName}` : undefined}
          address={agentAddress ?? undefined}
        />
      }
    >
      <div className="settings-banner settings-banner--info" role="status">
        <span aria-hidden><UserIcon size={18} /></span>
        <div>
          <strong>{request.appLabel} needs {request.required.length} field{request.required.length === 1 ? '' : 's'}</strong>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.82rem' }}>
            We&apos;ll save here at your home, then send you back to {request.appLabel}.
          </p>
        </div>
      </div>

      <RelyingProfileForm request={request} agentAddress={agentAddress ?? null} />
    </SettingsLayout>
  );
}

function RelyingProfileForm({
  request,
  agentAddress,
}: {
  request: RelyingRequest;
  agentAddress: `0x${string}` | null;
}) {
  const handleSaved = (contact: ImpactContactProfile) => {
    const saved = persistContact(contact);
    const ret = new URL(request.returnUrl);
    ret.searchParams.set('profile_state', request.state);
    const shared = projectLocationForShare(saved.location);
    for (const k of request.required) {
      if (k === 'location') {
        if (shared.formatted) ret.searchParams.set('profile_location', shared.formatted);
        if (shared.precision) ret.searchParams.set('profile_location_precision', shared.precision);
        if (shared.country) ret.searchParams.set('profile_country', shared.country);
        if (shared.region) ret.searchParams.set('profile_region', shared.region);
        if (shared.locality) ret.searchParams.set('profile_city', shared.locality);
        if (shared.street) ret.searchParams.set('profile_street', shared.street);
        if (shared.line2) ret.searchParams.set('profile_line2', shared.line2);
        if (shared.postalCode) ret.searchParams.set('profile_postalCode', shared.postalCode);
        continue;
      }
      const v = contactFieldValue(saved, k);
      if (v) ret.searchParams.set(`profile_${k}`, v);
    }
    window.location.href = ret.toString();
  };

  return (
    <PersonalInfoPanel
      agentAddress={agentAddress}
      requiredKeys={request.required}
      appLabel={request.appLabel}
      onSaved={handleSaved}
    />
  );
}
