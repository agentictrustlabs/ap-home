'use client';
// Org workspace — Work / Endeavor detail (spec 334 §6): outcome, adopted plan
// steps + satisfied status, participants + roles, commitments, provenance trail.
import { use } from 'react';
import type { Address } from '@agenticprimitives/types';
import { OrgWorkEndeavorDetail } from '../../../../../../src/components/portal/work/OrgWorkEndeavorDetail';

export default function OrgWorkEndeavorPage({ params }: { params: Promise<{ org: string; endeavor: string }> }) {
  const { org, endeavor } = use(params);
  return <OrgWorkEndeavorDetail org={org as Address} endeavorId={decodeURIComponent(endeavor)} />;
}
