// Org → Invite lives on Members (spec 324 §12). Keep this URL so relying-app ceremony
// links still work — but never 308, and never drop `return` / `app`. A cached 308 to
// `/membership` without those params is why Commons invitees stayed on Home after joining.
import { redirect } from 'next/navigation';

const KEEP = ['return', 'returnUrl', 'app'] as const;

export default async function OrgInviteRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org } = await params;
  const q = await searchParams;
  const next = new URLSearchParams();
  for (const key of KEEP) {
    const v = q[key];
    if (typeof v === 'string' && v) next.set(key, v);
  }
  const qs = next.toString();
  redirect(`/org/${org}/membership${qs ? `?${qs}` : ''}`);
}
