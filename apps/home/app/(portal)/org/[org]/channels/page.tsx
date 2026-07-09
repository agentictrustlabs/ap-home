'use client';
// Org workspace — Channels (spec 318 demo realization). Topic discussion inside THIS organization:
// the org SA is the channels namespace (communityId); membership = a self-signed directory listing
// in the org's community (ADR-0025 opt-in). See OrgChannelsView for the model.
import { use } from 'react';
import type { Address } from '@agenticprimitives/types';
import { OrgChannelsView } from '../../../../../src/components/portal/OrgChannelsView';

export default function OrgChannelsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <OrgChannelsView org={org as Address} />;
}
