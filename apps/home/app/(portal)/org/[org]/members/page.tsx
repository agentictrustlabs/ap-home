'use client';
// Members — who is in this organization, and how to reach them. Managing membership is Settings →
// Membership; this is the participation view.
import { use } from 'react';
import { MemberRoster } from '../../../../../src/components/portal/MemberRoster';

export default function OrgMembersPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <MemberRoster agent={org} />;
}
