'use client';
// Org workspace — Work (spec 334 §6): the Endeavor list / lifecycle board.
import { use } from 'react';
import type { Address } from '@agenticprimitives/types';
import { OrgWorkView } from '../../../../../src/components/portal/work/OrgWorkView';

export default function OrgWorkPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <OrgWorkView org={org as Address} />;
}
