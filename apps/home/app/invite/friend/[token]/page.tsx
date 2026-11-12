'use client';
// A friend's invitation lands here (spec 401 C1, by email). Signed in ⇒ one tap adds the inviter as a contact (role
// friend) through the Ask — the invitee's own act, their mandate, their grant — and the inviter's agent is told, so
// "Add back" shows in the inviter's messages; once they do, the two are friends. Not signed in ⇒ sign in or set up a
// home here first (email code), then the same tap. The link carries no authority: nothing here can befriend anyone
// without both people's own grants.
import { use, useEffect, useState } from 'react';
import { useSession } from '../../../../src/context/session';
import { EmailAuthCard } from '../../../../src/components/portal/EmailAuthCard';
import { BrandShield } from '../../../../src/components/shared/BrandShield';
import { AgentName } from '../../../../src/components/shared/AgentName';

interface Invite { from: string; fromName: string | null; note: string | null; expiresAt: string; accepted?: boolean; forYou?: boolean }

export default function FriendInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { session, agentAddress, agentName, phase } = useSession();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  // Signed in as an account the invitation was NOT sent to: confirm the invited email (opens that email's own Home),
  // or — "this is me" — add that email to the account signed in here.
  const [linkHere, setLinkHere] = useState(false);

  // Read again whenever who is signed in changes: the answer to "is this invitation for you" is per account.
  const bearer = session?.token ?? null;
  useEffect(() => {
    let cancelled = false;
    void fetch(`/connect/friend-invite/lookup?token=${encodeURIComponent(token)}`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : undefined)
      .then((r) => r.json())
      .then((d: Invite & { ok?: boolean; error?: string }) => { if (!cancelled) { if (d.ok) { setInvite(d); setErr(null); } else setErr(d.error ?? 'invalid invitation'); } })
      .catch(() => { if (!cancelled) setErr('could not load this invitation'); });
    return () => { cancelled = true; };
  }, [token, bearer]);
  const recheck = () => {
    if (!bearer) return;
    void fetch(`/connect/friend-invite/lookup?token=${encodeURIComponent(token)}`, { headers: { authorization: `Bearer ${bearer}` } })
      .then((r) => r.json()).then((d: Invite & { ok?: boolean }) => { if (d.ok) { setInvite(d); setLinkHere(false); } }).catch(() => {});
  };

  const who = invite?.fromName ?? null;
  const self = !!invite && !!agentAddress && invite.from.toLowerCase() === agentAddress.toLowerCase();

  const addBack = async () => {
    if (!invite || !session) return;
    setAdded(true); setErr(null);
    // The stash is spent once the invitee acted on it; the friendship grant is what makes the friendship, not this.
    // A refusal (signed in as someone the invitation was not sent to) stops here — it is never accepted as them.
    const claimed = await fetch('/connect/friend-invite/email', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ token, claim: true }),
    }).then(async (r) => ({ ok: r.ok, ...((await r.json().catch(() => ({}))) as { error?: string; wrongAccount?: boolean }) })).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e), wrongAccount: false }));
    if (!claimed.ok) {
      setAdded(false);
      if (claimed.wrongAccount) setInvite((i) => (i ? { ...i, forYou: false } : i));
      else setErr(claimed.error ?? 'this invitation could not be accepted');
      return;
    }
    // The add runs in the Ask, which lives in the portal — this page is outside it, so a command fired here was heard by
    // no one. Friends takes `?add=` and starts it there, with the invitation, so the inviter's half completes too.
    const q = new URLSearchParams({ add: invite.from, invitation: token, ...(who ? { name: who } : {}) });
    window.location.href = `/friends?${q}`;
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
            ) : session && agentAddress && invite.forYou === false ? (
              <>
                <p className="onboarding-sub">
                  This invitation was sent to a different email than the account signed in here (<b>{agentName ?? agentAddress}</b>).
                  {linkHere
                    ? <> Enter the email it was sent to — once it is confirmed, it is added to this account and you can accept here.</>
                    : <> Enter the email it was sent to — we’ll send a code and open that email’s own Home to accept it.</>}
                </p>
                {linkHere ? <EmailAuthCard onLinked={recheck} /> : <EmailAuthCard asInvitee />}
                <button type="button" className="onboarding-link" style={{ marginTop: '.75rem', background: 'none', border: 0, textDecoration: 'underline', cursor: 'pointer', color: 'inherit', opacity: 0.8 }} onClick={() => setLinkHere((v) => !v)}>
                  {linkHere ? 'No — open the Home for that email instead' : `That email is mine — add it to ${agentName ?? 'this account'} instead`}
                </button>
              </>
            ) : session && agentAddress ? (
              added ? (
                <p className="onboarding-sub">
                  Taking you to your friends to finish…
                </p>
              ) : (
                <>
                  <p className="onboarding-sub">You are signed in as <b>{agentName ?? agentAddress}</b>.</p>
                  <button type="button" className="onboarding-btn" onClick={() => void addBack()}>Add {who ?? 'them'} as a friend</button>
                </>
              )
            ) : (
              <>
                <p className="onboarding-sub" style={{ marginBottom: '.5rem' }}>Sign in, or set up your home with your email, to accept:</p>
                <EmailAuthCard asInvitee />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
