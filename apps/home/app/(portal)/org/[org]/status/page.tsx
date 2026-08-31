'use client';
// Organization → Settings → People & access → Status (spec 348 §2.3, spec 342).
// Renamed from `settings`: this page answers "is this organization active", not "how is it
// configured" — and `Settings` now names the pane this item sits in.
import { use } from 'react';
import { OrgSettingsSection } from '../../../../../src/components/portal/settings/org-manage';
export default function OrgSettingsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <OrgSettingsSection orgSa={org} />;
}
