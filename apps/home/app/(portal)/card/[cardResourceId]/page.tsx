'use client';
import { use } from 'react';
import { AgentCardEditorSection } from '../../../../src/components/studio/CardStudio';

export default function PersonAgentCardPage({ params }: { params: Promise<{ cardResourceId: string }> }) {
  const { cardResourceId } = use(params);
  return <AgentCardEditorSection kind="person" agent="" cardId={cardResourceId} />;
}
