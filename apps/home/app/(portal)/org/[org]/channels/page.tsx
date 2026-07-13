// Org workspace — legacy `channels` route. Spec 324 §12: "Channels" became "Discussions"; this path
// 308-permanent-redirects to /org/<sa>/discussions so old links + bookmarks keep working.
import { permanentRedirect } from 'next/navigation';

export default async function OrgChannelsRedirect({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  permanentRedirect(`/org/${org}/discussions`);
}
