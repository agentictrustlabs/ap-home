'use client';
import { use } from 'react';
import { AgentCardEditorSection } from '../../../../../../src/components/studio/CardStudio';

export default function AgentCardPage({ params }: { params: Promise<{ agent: string; cardResourceId: string }> }) {
  const { agent, cardResourceId } = use(params);
  return <AgentCardEditorSection kind="service" agent={agent} cardId={cardResourceId} />;
}
