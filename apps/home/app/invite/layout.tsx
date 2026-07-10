import type { ReactNode } from 'react';
import { SessionProvider } from '../../src/context/session';

// The invite-redeem route lives OUTSIDE (portal), so it gets its own SessionProvider — but WITHOUT the
// portal Gate: an anonymous invitee must reach the redeem page (and the email-bootstrap card), not be
// redirected to onboarding. The provider still restores an existing *.impact-agent.me SSO session, so a
// signed-in invitee lands straight on "Accept & join". (Fixes the client-side crash: the page + its
// embedded EmailAuthCard call useSession(), which throws with no provider in scope.)
export default function InviteLayout({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
