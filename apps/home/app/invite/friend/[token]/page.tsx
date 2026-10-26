'use client';
// A friend's invitation lands here (spec 401 C1, by email). Signed in ⇒ one tap adds the inviter as a contact (role
// friend) through the Ask — the invitee's own act, their mandate, their grant — and the inviter's agent is told, so
// "Add back" shows in the inviter's messages; once they do, the two are friends. Not signed in ⇒ sign in or set up a
// home here first (email code), then the same tap. The link carries no authority: nothing here can befriend anyone
// without both people's own grants.
import { use, useEffect, useState } from 'react';
import { useSession } from '../../../../src/context/session';
import { EmailAuthCard } from '../../../../src/components/portal/EmailAuthCard';
import { askCommand } from '../../../../src/home/ask-command';
import { BrandShield } from '../../../../src/components/shared/BrandShield';
import { AgentName } from '../../../../src/components/shared/AgentName';

interface Invite { from: string; fromName: string | null; note: string | null; expiresAt: string }

export default function FriendInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { session, agentAddress, agentName, phase } = useSession();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  useEffect(() => {
    void fetch(`/connect/friend-invite/lookup?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d: Invite & { ok?: boolean; error?: string }) => (d.ok ? setInvite(d) : setErr(d.error ?? 'invalid invitation')))
      .catch(() => setErr('could not load this invitation'));
  }, [token]);

  const who = invite?.fromName ?? null;
  const self = !!invite && !!agentAddress && invite.from.toLowerCase() === agentAddress.toLowerCase();

  const addBack = () => {
    if (!invite || !session) return;
    askCommand({ toolId: 'person.friend.add', args: { friend: invite.from, type: 'friend', invitation: token }, message: `add ${who ?? invite.from} as a friend` });
    setAdded(true);
    // The stash is spent once the invitee acted on it; the contact grant is what makes the friendship, not this.
    void fetch('/connect/friend-invite/email', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ token, claim: true }),
    }).catch(() => {});
  };

  return (
    <div className="onboarding-screen">
      <div className="onboarding-card wide">
        <BrandShield size={48} />
        {err && <p className="onboarding-error">{err}</p>}
        {!invite ? (
          !err ? <p className="onboarding-sub">Loading invitation…</p> : <p className="onboarding-sub">This invitation could not be opened. Ask your friend for a new link.</p>
        ) : (
          <>
            <h1 className="onboarding-h1">{who ?? 'A friend'} wants to be friends</h1>
            <p className="onboarding-sub">
              {who ? <>{who} (<AgentName address={invite.from} />)</> : <AgentName address={invite.from} />} invited you to be friends here.
              Friends see what each other share; nothing of yours is read without a grant you sign.
            </p>
            {invite.note && <blockquote className="onboarding-sub" style={{ borderLeft: '3px solid var(--color-sage-500)', paddingLeft: 12, opacity: 0.85 }}>{invite.note}</blockquote>}
            {phase === 'restoring' ? (
              <p style={{ opacity: 0.7 }}>Checking who is signed in…</p>
            ) : self ? (
              <p className="onboarding-sub">This is your own invitation — send the link to your friend.</p>
            ) : session && agentAddress ? (
              added ? (
                <p className="onboarding-sub">
                  Sign the contact grant in the panel that opened, and {who ?? 'your friend'} is told. Once they add you back you are friends.
                  {' '}<a href="/friends">Your friends →</a>
                </p>
              ) : (
                <>
                  <p className="onboarding-sub">You are signed in as <b>{agentName ?? agentAddress}</b>.</p>
                  <button type="button" className="onboarding-btn" onClick={addBack}>Add {who ?? 'them'} as a friend</button>
                </>
              )
            ) : (
              <>
                <p className="onboarding-sub" style={{ marginBottom: '.5rem' }}>Sign in, or set up your home with your email, to accept:</p>
                <EmailAuthCard />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
