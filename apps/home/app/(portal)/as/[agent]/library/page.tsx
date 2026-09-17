'use client';
import { use } from 'react';
import { LibrarySection } from '../../../../../src/components/portal/LibrarySection';

export default function PersonaLibraryPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <LibrarySection orgSa={agent} />;
}
