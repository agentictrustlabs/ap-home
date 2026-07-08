// Spec 313 v2: the Chats surface merged into the unified Messages view.
import { redirect } from 'next/navigation';

export default function ChatsRedirect() {
  redirect('/messages');
}
