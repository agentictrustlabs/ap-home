'use client';
// Org workspace — Discussions (spec 324 §10). The org's forum-profile Conversation, presented as Topics:
// each Topic is a DiscussionTopic inside the org's discussion space (not a sibling conversation). See
// OrgDiscussionsView for the model. (Old `/org/<sa>/channels` 308-redirects here.)
import { use } from 'react';
import type { Address } from '@agenticprimitives/types';
import { OrgDiscussionsView } from '../../../../../src/components/portal/OrgDiscussionsView';

export default function OrgDiscussionsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <OrgDiscussionsView org={org as Address} />;
}
