// "Contacts" is "Friends" now. next.config redirects `/contacts` before this renders; this page is the
// fallback for a client-side navigation, and it keeps the query (an app's `?add=…&from=…` request).
import { redirect } from 'next/navigation';

export default async function ContactsRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, x);
  const qs = q.toString();
  redirect(qs ? `/friends?${qs}` : '/friends');
}
