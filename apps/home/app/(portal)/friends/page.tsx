'use client';
// Friends (spec 401) — two-way relationships: you add someone, they accept, and you are friends.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { FriendsPanel } from '../../../src/components/portal/FriendsPanel';

export default function FriendsPage() {
  return (
    <SectionShell
      title="Friends"
      description="People you’re connected with. You become friends when you both say yes."
    >
      <FriendsPanel />
    </SectionShell>
  );
}
