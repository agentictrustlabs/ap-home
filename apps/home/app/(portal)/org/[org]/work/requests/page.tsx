'use client';
// Org workspace — Work / Requests triage (spec 334 §6): pending EndeavorRequests
// with explicit steward accept / decline.
import { use } from 'react';
import type { Address } from '@agenticprimitives/types';
import { OrgWorkRequestsView } from '../../../../../../src/components/portal/work/OrgWorkRequestsView';

export default function OrgWorkRequestsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <OrgWorkRequestsView org={org as Address} />;
}
