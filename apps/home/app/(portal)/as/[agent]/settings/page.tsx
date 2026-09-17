import { redirect } from 'next/navigation';
export default async function ServiceSettingsIndex({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = await params;
  redirect(`/service/${agent}/profile`);
}
