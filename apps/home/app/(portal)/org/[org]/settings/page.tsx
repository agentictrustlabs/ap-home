import { redirect } from 'next/navigation';
export default async function OrgSettingsIndex({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  redirect(`/org/${org}/profile`);
}
