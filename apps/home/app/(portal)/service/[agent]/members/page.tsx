'use client';
// Members — who is in this workspace. A service agent that coordinates people has a roster like an
// organization's; one that does not (a treasury, a registry) has no Members item in its nav at all.
import { use } from 'react';
import { MemberRoster } from '../../../../../src/components/portal/MemberRoster';

export default function ServiceMembersPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <MemberRoster agent={agent} />;
}
