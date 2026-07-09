'use client';
// Service workspace — Messages (spec 313/315 / ADR-0046). Messages sent TO this service agent, read by the
// managing person (server re-verifies control on every read/action). Reuses the shared MessagesView.
import { use } from 'react';
import type { Address } from '@agenticprimitives/types';
import { MessagesView } from '../../../../../src/components/portal/MessagesView';

export default function ServiceMessagesPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <MessagesView targetAgent={agent as Address} />;
}
