'use client';
// Org workspace — Messages (spec 313/315). The URL carries the org SA; the person reads the org's inbox
// (messages sent TO the org agent) because they control it. The shared MessagesView is scoped by targetAgent;
// the /connect/inbox server re-verifies control (managed-agents) on every read/action.
import { use } from 'react';
import type { Address } from '@agenticprimitives/types';
import { MessagesView } from '../../../../../src/components/portal/MessagesView';

export default function OrgMessagesPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <MessagesView targetAgent={org as Address} />;
}
