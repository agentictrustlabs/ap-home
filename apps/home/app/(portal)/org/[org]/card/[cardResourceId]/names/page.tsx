'use client';
import { use } from 'react';
import { NamesBindingsSection } from '../../../../../../../src/components/studio/CardStudio';

export default function NamesPage({ params }: { params: Promise<{ org: string; cardResourceId: string }> }) {
  const { org, cardResourceId } = use(params);
  return <NamesBindingsSection kind="org" agent={org} cardId={cardResourceId} />;
}
