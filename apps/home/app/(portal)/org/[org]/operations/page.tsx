'use client';
// An ORGANIZATION'S operations (owner, 2026-10-05): the operator view over the org's own agents — itself, its teams and their
// circles, the workspace it governs. Steward-only at the runtime (`/harness/ops` scope `organization`); never members' agents.
import { use } from 'react';
import { OperationsView } from '../../../../../src/components/portal/OperationsView';

export default function OrgOperationsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <OperationsView org={org as `0x${string}`} />;
}
