'use client';
import { use } from 'react';
import { LibrarySection } from '../../../../../src/components/portal/LibrarySection';

export default function OrgLibraryPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <LibrarySection orgSa={org} />;
}
