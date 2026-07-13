// Org → Invite: consolidated into the Members surface (spec 324 §12 — ONE enrollment surface). This standalone
// route 308-permanent-redirects to /org/<sa>/members, where the Invite panel now lives with the roster.
import { permanentRedirect } from 'next/navigation';

export default async function OrgInviteRedirect({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  permanentRedirect(`/org/${org}/members`);
}
