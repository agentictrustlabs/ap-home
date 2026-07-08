// Spec 313 v2: people search lives in the Messages composer; org discovery in
// Networks; community browse in Channels (membership) + the You page (listing).
import { redirect } from 'next/navigation';

export default function FindRedirect() {
  redirect('/messages');
}
