'use client';
// Org workspace — Build (spec 398 §9 / ap-build B3): the build runs the workspace's agent left, and a task to run.
import { use } from 'react';
import type { Address } from '@agenticprimitives/types';
import { BuildView } from '../../../../../src/components/portal/BuildView';

export default function OrgBuildPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <BuildView org={org as Address} />;
}
