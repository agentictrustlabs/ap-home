'use client';
import { use } from 'react';
import { AgentCardEditorSection } from '../../../../../../src/components/studio/CardStudio';

export default function AgentCardPage({ params }: { params: Promise<{ org: string; cardResourceId: string }> }) {
  const { org, cardResourceId } = use(params);
  return <AgentCardEditorSection kind="org" agent={org} cardId={cardResourceId} />;
}
