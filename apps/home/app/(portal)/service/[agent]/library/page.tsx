'use client';
import { use } from 'react';
import { LibrarySection } from '../../../../../src/components/portal/LibrarySection';

// A service's Library is ITS OWN vault, read over your stewardship delegation (the agent → you) — the same read
// its Records page makes. It is not an organization's Library: `orgSa` routed it through the org's
// InteractionsDO, which an agent another app provisioned does not carry, and the page read "nothing here".
export default function ServiceLibraryPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <LibrarySection heldAgent={agent} />;
}
