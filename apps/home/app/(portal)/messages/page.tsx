'use client';
// Person workspace Messages route (spec 313) — the person's own inbox. Renders the shared MessagesView
// (extracted to a component so the org/service message routes can reuse it, spec 315).
import { MessagesView } from '../../../src/components/portal/MessagesView';

export default function MessagesPage() {
  return <MessagesView />;
}
