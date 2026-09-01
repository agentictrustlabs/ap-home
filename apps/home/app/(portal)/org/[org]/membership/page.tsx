'use client';
// Settings → People & access → Membership (spec 348 §2.3) — who gets in and who is removed: the
// roster with its controls, pending applications, and invites. Seeing WHO IS HERE is the main-nav
// Members page; looking a colleague up should not put you on a screen of pending applications.
import { use } from 'react';
import { OrgMembersSection } from '../../../../../src/components/portal/settings/org-manage';
export default function OrgMembersPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <OrgMembersSection orgSa={org} />;
}
