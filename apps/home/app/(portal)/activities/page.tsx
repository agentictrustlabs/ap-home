'use client';
// Activities — the person's own control-plane timeline. The renderer is shared with the org and service
// Activities pages (src/components/portal/ActivityTimeline.tsx): there is ONE control plane, and an
// agent's Activities is the subset of it that names that agent, not a separate feed.
import { ActivityTimeline } from '../../../src/components/portal/ActivityTimeline';

export default function ActivitiesPage() {
  return <ActivityTimeline />;
}
