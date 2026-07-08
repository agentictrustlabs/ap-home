// Spec 313 v2: the Inbox surface merged into the unified Messages view.
import { redirect } from 'next/navigation';

export default function InboxRedirect() {
  redirect('/messages');
}
