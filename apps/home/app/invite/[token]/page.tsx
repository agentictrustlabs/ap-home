'use client';
// Invite redemption landing (spec 315 invite). The invitee lands here from the email link (or an in-app
// chip). Signed in ⇒ accept = publish their own self-signed directory listing into the org's community
// (ADR-0025 — they consent by signing; this makes them an authority-only member). Not signed in ⇒ prompt
// to sign in first (any method, incl. email). One invitation, redeemed by joining.
import { use, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { issueDirectoryListing } from '../../../src/home/directory';
import { orgHref } from '../../../src/lib/workspace';
import { EmailAuthCard } from '../../../src/components/portal/EmailAuthCard';
import { secureHomeNoName, activateVault, signHashFor, resolveVia } from '../../../src/home/onboarding';
import { recordOrgMembership } from '../../../src/lib/org-membership';
import { emailInviteNeedsSignOut } from '../../../src/lib/email-invite-home';
import { inviteAcceptLabel, inviteHeadline, inviteLead } from '../../../src/lib/invite-copy';
import { claimName } from '../../../src/connect-client';
import { provisionCommunityMessaging } from '../../../src/lib/messaging-ceremony';
import { nameLabel } from '../../../src/lib/domain';
import { BusyButton } from '../../../src/components/shared/BusyButton';
import type { Hex } from '@agenticprimitives/types';

// Coerce ANY thrown shape to a readable string — Error, a string, or a plain object with a `.message`
// (MetaMask/RPC rejections are objects like `{ code: 4001, message: 'User rejected …' }`, NOT Error
// instances, so `instanceof Error` alone silently dropped them to the fallback).
const asMsg = (x: unknown, fallback: string): string => {
  if (typeof x === 'string' && x) return x;
  if (x && typeof x === 'object') {
    const m = (x as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
    try { const s = JSON.stringify(x); if (s && s !== '{}') return s; } catch { /* non-serializable */ }
  }
  return fallback;
};

/** Listings are name-addressed. Email redeem deploys a nameless home; claim the typed handle first. */
function joinLabel(displayName: string): string {
  const raw = nameLabel(displayName)
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return raw || 'member';
}

/** Returns the home's ACTUAL public name. For an already-named home `claimName` is a NO-OP that
 *  reports the established name (spec 257 — one name per agent): the typed join name becomes the
 *  ORG-LOCAL listing displayName only, never a second public name. Callers must continue under the
 *  returned name, not the typed one — pinning a name the home does not hold onto the app's sign-in
 *  makes the enroll chase a name that resolves to nobody. */
async function claimJoinName(
  agent: Address,
  sign: (h: Hex) => Promise<Hex>,
  displayName: string,
): Promise<string> {
  const claimed = await claimName(agent, sign, joinLabel(displayName));
  if (!claimed.ok) throw new Error(claimed.error);
  return claimed.name.includes('.') ? claimed.name : `${joinLabel(displayName)}.impact`;
}

export default function InviteRedeemPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { session, profile, agentAddress, agentName, openSession, signOut, phase } = useSession();
  const [invite, setInvite] = useState<{
    org: string;
    orgName: string;
    returnUrl?: string;
    appName?: string | null;
    invitedAgent?: string | null;
    invitedBy?: string | null;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [otpFallback, setOtpFallback] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const org = q.get('o') ?? '';
    const app = q.get('app') ?? '';
    const lookup = new URLSearchParams({ token, o: org });
    if (app) lookup.set('app', app);
    void fetch(`/connect/org-invite/lookup?${lookup.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setInvite({
            org: d.org,
            orgName: d.orgName,
            returnUrl: d.returnUrl,
            appName: d.appName ?? null,
            invitedAgent: typeof d.invitedAgent === 'string' ? d.invitedAgent : null,
            invitedBy: typeof d.invitedBy === 'string' ? d.invitedBy : null,
          });
        } else setErr(d.error ?? 'invalid invitation');
      })
      .catch(() => setErr('could not load this invitation'));
  }, [token]);

  /** Where the invitee continues once they've joined: back into the app the invitation was raised
   *  from (origin-checked against that app when the invite was created) carrying the name they just
   *  chose and the person agent they joined as — otherwise the org's own space at this Home. */
  const goOn = (org: string, member: string, name: string, homeSession?: string, agent?: string) => {
    if (!invite?.returnUrl) { window.location.assign(orgHref(org, 'discussions')); return; }
    const u = new URL(invite.returnUrl);
    if (!u.searchParams.get('org')) u.searchParams.set('org', org);
    u.searchParams.set('n', name);
    u.searchParams.set('sa', member);
    if (agent) u.searchParams.set('agent', agent);
    // Fragment, not a query: Commons attaches this to the authorize URL so Home
    // plants the email home instead of showing the generic sign-in chooser.
    if (homeSession) {
      const frag = new URLSearchParams();
      frag.set('session', homeSession);
      frag.set('via', 'email');
      u.hash = frag.toString();
    }
    window.location.assign(u.toString());
  };

  const accept = async () => {
    if (!session || !agentAddress || !invite) return;
    if (emailInviteNeedsSignOut(agentAddress, invite.invitedAgent)) {
      setErr('Sign out first — this invitation is for a different home.');
      return;
    }
    setBusy(true); setErr(null);
    try {
      // Route by the home's ACTUAL on-chain credential, not the cookie `via` — a Google/KMS home has no
      // wallet/passkey, and the naive cookie via would wrongly pop MetaMask (or a passkey prompt).
      const via = resolveVia(profile?.credential, session.via);
      const sign = await signHashFor(via, agentAddress as Address, { token: session.token });
      const name = displayName.trim() || (agentName ? agentName.split('.')[0]! : 'Member');
      const publicName = await claimJoinName(agentAddress as Address, sign, name);
      const listing = await issueDirectoryListing(agentAddress as Address, sign, {
        communityId: invite.org.toLowerCase(),
        displayName: name,
      });
      const res = await fetch('/connect/directory', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ action: 'publish', listing }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: unknown };
      if (!res.ok || !body.ok) throw new Error(asMsg(body.error, `join failed (${res.status})`));
      await recordOrgMembership(agentAddress as Address, invite.org.toLowerCase(), sign, session.token, null, name);
      await provisionCommunityMessaging({
        person: agentAddress as Address,
        org: invite.org.toLowerCase(),
        named: true, // claimJoinName just claimed (or confirmed) their public name
        extra: invite.invitedBy && /^0x[0-9a-f]{40}$/.test(invite.invitedBy) ? [invite.invitedBy as Address] : [],
        via,
        token: session.token,
      }).catch((e) => { console.warn('[invite] community messaging provision failed (non-fatal):', e); });
      goOn(invite.org.toLowerCase(), agentAddress, name, session.token, agentName || publicName);
    } catch (e) { setErr(asMsg(e, 'could not join')); } finally { setBusy(false); }
  };

  // Magic-link accept (anonymous invitee, no prior home): clicking the emailed link proves inbox
  // possession, so the server bootstraps a KMS-custodied home bound to the invited email — no OTP, no app.
  // We then secure it on-chain, publish the invitee's self-signed join listing, and open the session. If
  // the org kept no email hash for this token, the server returns `needs-otp` → fall back to the code card.
  const redeemWithLink = async () => {
    if (!invite) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/connect/org-invite/redeem', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, org: invite?.org }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; status?: string; token?: string; error?: unknown; memberAccessDelegation?: { delegate?: string } | null };
      if (r.ok && d.status === 'needs-otp') { setOtpFallback(true); return; }
      if (!r.ok || !d.ok || !d.token) throw new Error(asMsg(d.error, 'could not accept the invitation'));
      const res = await secureHomeNoName({ token: d.token });
      if (!res.ok) throw new Error(res.error);
      // Open the session NOW, not after the join writes. The messaging provision below installs the
      // wire through calls that authenticate with the STORED session (`homeBearer()` reads
      // localStorage, not a parameter) — opened last, every one of them threw 'no home session'
      // into the non-fatal catch, and the invitee arrived with no wire at all: the send back to
      // the person who invited them was refused as the very first thing they tried.
      await openSession(d.token, 'email', false);
      void activateVault(res.home.address, 'email', { token: d.token }); // spec 278 — best-effort vault
      // Fresh email-bootstrapped home → KMS via; signs server-side with the session token (no device prompt).
      const sign = await signHashFor('email', res.home.address, { token: d.token });
      // NAMELESS BY DESIGN. The typed name is how this ORGANIZATION knows them — the directory
      // listing's displayName — never a public handle. A public name is its own ceremony the person
      // runs later at their Home if they want one; claiming one here would spend a global,
      // transferable identifier on a word typed into a join box.
      const name = displayName.trim() || 'Member';
      const listing = await issueDirectoryListing(res.home.address, sign, {
        communityId: invite.org.toLowerCase(),
        displayName: name,
      });
      const pub = await fetch('/connect/directory', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${d.token}` },
        // PRESENT THE GRANT WE WERE JUST HANDED. The org authorized this join when the steward signed
        // it; redeem returned it two lines ago. Publishing without it made the server look the grant
        // up in a record `recordOrgMembership` writes on the NEXT line — so the join could only ever
        // have worked on a second attempt, and the invite was already marked redeemed by then.
        body: JSON.stringify({ action: 'publish', listing, ...(d.memberAccessDelegation ? { memberAccess: d.memberAccessDelegation } : {}) }),
      });
      const pj = (await pub.json().catch(() => ({}))) as { ok?: boolean; error?: unknown };
      if (!pub.ok || !pj.ok) throw new Error(asMsg(pj.error, `join failed (${pub.status})`));
      await recordOrgMembership(res.home.address, invite.org.toLowerCase(), sign, d.token, d.memberAccessDelegation, name); // KMS-signed — no device prompt
      // A nameless member's reach is exactly the scope-class rule: co-members of this org (the org-SA
      // class, resolved live at the gate) plus the person who invited them. No registry class — they
      // hold no public name for the named-to-named scope to stand on.
      await provisionCommunityMessaging({
        person: res.home.address,
        org: invite.org.toLowerCase(),
        extra: invite.invitedBy && /^0x[0-9a-f]{40}$/.test(invite.invitedBy) ? [invite.invitedBy as Address] : [],
        via: 'email',
        token: d.token,
      }).catch((e) => { console.warn('[invite] community messaging provision failed (non-fatal):', e); });
      goOn(invite.org.toLowerCase(), res.home.address, name, d.token);
    } catch (e) { setErr(asMsg(e, 'could not join')); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 440, margin: '4rem auto', padding: '1.5rem', fontFamily: 'system-ui, sans-serif' }}>
      {err && <p style={{ color: '#b91c1c' }}>{err}</p>}
      {!invite ? (
        !err && <p style={{ opacity: 0.7 }}>Loading invitation…</p>
      ) : (
        <>
          <h1 style={{ fontSize: '1.4rem' }}>{inviteHeadline(invite.orgName, invite.appName)}</h1>
          {phase === 'restoring' ? (
            <p style={{ opacity: 0.7 }}>Checking who is signed in…</p>
          ) : emailInviteNeedsSignOut(agentAddress, invite.invitedAgent) ? (
            <>
              <p style={{ fontSize: '.9rem', opacity: 0.75 }}>
                You&rsquo;re signed in as <b>{agentName ?? agentAddress}</b>. This invitation is for a
                different home — the one bound to the invited email. Accepting here would join the
                wrong person.
              </p>
              <BusyButton busy={false} busyLabel="Signing out…" onClick={() => signOut()}>
                Sign out to accept this invitation
              </BusyButton>
              <p style={{ fontSize: '.75rem', opacity: 0.55, marginTop: '.6rem' }}>
                After you sign out, this link sets up the invited home
                {invite.appName ? ` and takes you to ${invite.appName}` : ` and joins ${invite.orgName}`}.
              </p>
            </>
          ) : session && agentAddress ? (
            <>
              <p style={{ fontSize: '.9rem', opacity: 0.75 }}>{inviteLead(invite.orgName, invite.appName)}</p>
              <label style={{ fontSize: '.78rem', opacity: 0.7 }}>
                How you are known in {invite.appName ? `${invite.appName} · ${invite.orgName}` : invite.orgName}
              </label>
              <input
                placeholder="Display name (how members see you)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                style={{ width: '100%', padding: '.55rem .7rem', margin: '.6rem 0', borderRadius: 8, border: '1px solid #d1d5db' }}
              />
              <BusyButton busy={busy} busyLabel="Signing…" onClick={() => void accept()}>
                {inviteAcceptLabel(invite.orgName, invite.appName)}
              </BusyButton>
              {(() => {
                const via = resolveVia(profile?.credential, session.via);
                const label = via === 'wallet' ? 'your wallet — a signature request will appear'
                  : via === 'passkey' ? 'your passkey'
                  : 'your secured account (no prompt)';
                return (
                  <p style={{ fontSize: '.75rem', opacity: 0.55, marginTop: '.5rem' }}>
                    Signs with {label}. <span style={{ opacity: 0.8 }}>(credential: {profile?.credential ?? '—'})</span>
                  </p>
                );
              })()}
            </>
          ) : (
            <>
              <p style={{ fontSize: '.9rem', opacity: 0.75 }}>{inviteLead(invite.orgName, invite.appName)}</p>
              <label style={{ fontSize: '.78rem', opacity: 0.7 }}>
                How you are known in {invite.appName ? `${invite.appName} · ${invite.orgName}` : invite.orgName}
              </label>
              <input
                placeholder="Display name (how members see you)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                style={{ width: '100%', padding: '.55rem .7rem', margin: '.6rem 0', borderRadius: 8, border: '1px solid #d1d5db' }}
              />
              {!otpFallback ? (
                <>
                  {/* One-click: the emailed link is the email-validation proof (magic link) → the server
                      bootstraps a KMS home bound to the invited email and this handler joins the org. */}
                  <BusyButton busy={busy} busyLabel="Setting up your home…" onClick={() => void redeemWithLink()}>
                    {inviteAcceptLabel(invite.orgName, invite.appName)}
                  </BusyButton>
                  <a className="btn-ghost" href={`/?invite=${encodeURIComponent(token)}`} style={{ display: 'block', marginTop: '.7rem' }}>
                    Already have a home? Use a passkey, wallet, or Google
                  </a>
                  {/*
                    THE CONSEQUENCE, SAID BEFORE THE CLICK.

                    This invitation's access grant is pre-signed against the address derived from the
                    invited EMAIL. Signing in as a different home leaves it inert — never re-targeted,
                    because re-aiming a steward's signature at whoever clicked is not a grant. Without
                    this line the affordance reads as an equivalent route and is not one: it ends at
                    "this organization has not authorized you to join", two screens later, with no
                    mention of an address.
                  */}
                  <p style={{ fontSize: '.72rem', opacity: 0.62, marginTop: '.45rem', lineHeight: 1.45 }}>
                    This invitation is addressed to the email it was sent to. If you sign in as a
                    different home, you can still get in — but a steward has to invite that agent
                    directly, because the access it carries is bound to the invited address.
                  </p>
                </>
              ) : (
                <>
                  {/* Fallback: no email hash stored for this token → verify by code, then Accept & join. */}
                  <p style={{ fontSize: '.85rem', opacity: 0.7, marginBottom: '.5rem' }}>
                    Verify your email to continue:
                  </p>
                  <EmailAuthCard />
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
