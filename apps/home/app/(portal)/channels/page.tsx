// Spec 318: channels are an ORG-workspace surface (topic discussion INSIDE an organization), no longer a
// person-scope community board. The old person-scope /channels page was retired at the vault cutover
// (spec 317 — it rendered inline KV bodyText the server no longer returns). Select an organization from
// the workspace switcher to reach its channels; this route redirects to Messages.
import { redirect } from 'next/navigation';

export default function ChannelsRedirect() {
  redirect('/messages');
}
