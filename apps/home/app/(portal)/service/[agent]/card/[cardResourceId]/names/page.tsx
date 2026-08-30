'use client';
import { use } from 'react';
import { NamesBindingsSection } from '../../../../../../../src/components/studio/CardStudio';

export default function NamesPage({ params }: { params: Promise<{ agent: string; cardResourceId: string }> }) {
  const { agent, cardResourceId } = use(params);
  return <NamesBindingsSection kind="service" agent={agent} cardId={cardResourceId} />;
}
