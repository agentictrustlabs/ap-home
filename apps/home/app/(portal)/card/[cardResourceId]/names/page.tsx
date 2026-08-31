'use client';
import { use } from 'react';
import { NamesBindingsSection } from '../../../../../src/components/studio/CardStudio';

export default function PersonNamesPage({ params }: { params: Promise<{ cardResourceId: string }> }) {
  const { cardResourceId } = use(params);
  return <NamesBindingsSection kind="person" agent="" cardId={cardResourceId} />;
}
