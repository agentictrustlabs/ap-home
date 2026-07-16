'use client';
// Org Discussions (spec 324 §10) — the org's forum-profile Conversation, presented as Topics (Telegram-forum
// shape: each Topic is a DiscussionTopic inside the org's discussion space, NOT a sibling conversation) with a
// Telegram-style member→DM slide-over, group avatars, rich messages (emoji + images), amber design system.
// NOTE: the internal transport keys (`/connect/channels`, `channelId`, `communityId`, CSS `channels-*`) are
// unchanged pending the W6 record-key migration; only the user-facing vocabulary is Discussions/Topics here.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { MessageEnvelopeV1 } from '@agenticprimitives/fabric/messaging';
import { useSession } from '../../context/session';
import { SectionShell } from './SectionShell';
import { issueDirectoryListing } from '../../home/directory';
import { activateVaultIfNeeded, activateInboxDeliveryIfNeeded, activateInteractionsIfNeeded, isKmsVia, resolveVia, signHashFor, type Via } from '../../home/onboarding';
import { recordOrgMembership } from '../../lib/org-membership';
import { notifyAgentsChanged } from './ManagedAgents';
import { vaultReadWithDelegation } from '../../lib/vault-client';
import { issueOrganizationResourceAccessDelegation, toWire, type DelegationWire } from '../../lib/delegation';
import { DELIVERY_SERVICE_SA, MCP_SERVER_ID } from '../../lib/inbox-delivery';
import { BusyButton } from '../shared/BusyButton';
import { searchAgentsKb, type AgentSearchHit } from '../../lib/agent-search';
import {
  communityAvatarKey,
  personAvatarKey,
  setCommunityAvatar,
} from '../../lib/avatar-store';
import { AvatarUpload } from './chat/AvatarUpload';
import { MessageBubble } from './chat/MessageBubble';
import { MessageComposer } from './chat/MessageComposer';
import { DmSlideOver } from './chat/DmSlideOver';
import { ProfileSheet, type ProfileTarget } from './chat/ProfileSheet';
import { useAvatar } from './chat/use-avatar';

interface ChannelMessage { envelope: MessageEnvelopeV1; authorName: string }
// participationPolicy (tbox/messaging.ttl): open — every org MEMBER participates automatically (derived
// from membership; no stored list); restricted — invite-only, participation asserted per person.
interface Channel { descriptor: { id: string; owner: string }; title: string; createdBy: string; messages: ChannelMessage[]; participationPolicy?: 'open' | 'restricted' }
interface Listing { listing: { subject: string; displayName: string; communityId: string }; label: string }
interface ParticipantRow { personSA: string; personName?: string; role: 'facilitator' | 'contributor'; derived?: boolean }
interface PendingInviteRow { id: string; invitedAgent: string; invitedName?: string; role: 'facilitator' | 'contributor' }

const timeShort = (iso: string): string => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

function MemberAvatar({ listing }: { listing: Listing }) {
  const imageUrl = useAvatar(personAvatarKey(listing.listing.subject));
  return <AvatarUpload name={listing.listing.displayName} imageUrl={imageUrl} size={34} />;
}

function PosterAvatar({ name, subject }: { name: string; subject?: string }) {
  const imageUrl = useAvatar(subject ? personAvatarKey(subject) : null);
  return <AvatarUpload name={name} imageUrl={imageUrl} size={30} />;
}

export function OrgDiscussionsView({ org }: { org: Address }) {
  const { session, profile: homeProfile, agentAddress, agentName } = useSession();
  const communityId = org.toLowerCase();
  const communityAvatar = useAvatar(communityAvatarKey(org));

  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [orgVault, setOrgVault] = useState<boolean | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [you, setYou] = useState<string | null>(null);
  const [member, setMember] = useState<boolean | null>(null);
  const [steward, setSteward] = useState(false);
  // spec 321 W2b — the org info a MEMBER may read over their member-access grant (org→member,
  // vault:org:profile). Steward-independent: read from the ORG's vault via the delegation itself.
  const [orgAbout, setOrgAbout] = useState<{ displayName?: string; description?: string; website?: string } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joinName, setJoinName] = useState('');
  const [applyMessage, setApplyMessage] = useState('');
  const [applied, setApplied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newPolicy, setNewPolicy] = useState<'open' | 'restricted'>('open');
  // Participants of the ACTIVE restricted topic (asserted DiscussionParticipation projections) +
  // pending invitations. Open topics never load these — participation is derived from membership.
  const [participants, setParticipants] = useState<ParticipantRow[] | null>(null);
  const [pendingInvites, setPendingInvites] = useState<PendingInviteRow[]>([]);
  const [participantBusy, setParticipantBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteQuery, setInviteQuery] = useState('');
  const [inviteHits, setInviteHits] = useState<AgentSearchHit[] | null>(null);
  const [inviteSent, setInviteSent] = useState<string | null>(null);
  // Restricted-topic participant invite popover (filterable roster of existing org members).
  const [topicInviteOpen, setTopicInviteOpen] = useState(false);
  const [topicInviteFilter, setTopicInviteFilter] = useState('');
  const [profile, setProfile] = useState<ProfileTarget | null>(null);
  const [dm, setDm] = useState<{ name: string; label: string; subject?: string } | null>(null);

  const authed = useMemo(
    () => ({ 'content-type': 'application/json', authorization: `Bearer ${session?.token ?? ''}` }),
    [session],
  );

  const load = useCallback(async () => {
    if (!session) return;
    const qs = active ? `&channelId=${encodeURIComponent(active)}` : '';
    const [chRes, dirRes] = await Promise.all([
      fetch(`/connect/channels?communityId=${communityId}${qs}`, { headers: authed }),
      fetch(`/connect/directory?communityId=${communityId}`, { headers: authed }),
    ]);
    if (dirRes.ok) {
      const d = (await dirRes.json()) as { listings?: Listing[] };
      setListings(d.listings ?? []);
    }
    if (chRes.status === 403) {
      // Non-member: the enrollment card (Request to join / Complete membership) IS the explanation now (spec
      // §12). Don't leak the DO's old listing-first gate message ("publish a directory listing to enter") into
      // it — that framing contradicts request→approve→complete. Clear any stale error too.
      setMember(false); setChannels(null); setError(null); return;
    }
    if (!chRes.ok) {
      const b = (await chRes.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? `channels read failed (${chRes.status})`); return;
    }
    const c = (await chRes.json()) as { channels: Channel[]; bodies?: Record<string, string>; you: string; orgVaultEnabled?: boolean; needsReEnable?: boolean; reason?: string; membership?: string; steward?: boolean };
    // Storage not usable → say WHY. A STALE grant (a wave widened the interactions scope) is distinct
    // from never-enabled: the steward must RE-Enable to re-sign, and the banner now explains it.
    if (c.orgVaultEnabled === false && c.reason) setError(c.needsReEnable ? `storage was upgraded — a steward must re-enable to continue (${c.reason})` : c.reason);
    if (c.membership && c.membership !== 'linked') setError(`membership link: ${c.membership}`);
    setMember(true);
    setSteward(c.steward === true);
    setYou(c.you);
    setChannels(c.channels);
    setBodies(c.bodies ?? {});
    setOrgVault(c.orgVaultEnabled === true);
    setActive((cur) => cur ?? c.channels[0]?.descriptor.id ?? null);
  }, [session, communityId, authed, active]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    // 12s (was 5s): each poll drives 2 delegated vault reads (channels + directory); at 5s an open tab
    // alone kept the free RPC near its rate limit, which is what made valid reads flake intermittently.
    // The a2a DO reads no longer re-verify the grant on-chain per op, but a slower poll keeps headroom.
    const t = setInterval(() => void load(), 12000);
    return () => clearInterval(t);
  }, [load]);

  // spec 321 W2b — if this viewer holds a member-access grant for the org, read its shareable
  // profile over it (one mechanism: the delegation; no steward session involved).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/connect/related-orgs', { headers: { authorization: `Bearer ${session.token}` } });
        const b = (await r.json().catch(() => ({}))) as { orgs?: Array<{ orgAgent?: string; memberAccessDelegation?: DelegationWire | null }> };
        const mad = (b.orgs ?? []).find((o) => (o.orgAgent ?? '').toLowerCase() === communityId)?.memberAccessDelegation;
        if (!mad || cancelled) return;
        const about = await vaultReadWithDelegation<{ displayName?: string; description?: string; website?: string }>(mad, 'org.profile');
        if (!cancelled && about) setOrgAbout(about);
      } catch { /* no grant / no profile — the card just doesn't render */ }
    })();
    return () => { cancelled = true; };
  }, [session, communityId]);

  const join = useCallback(async () => {
    if (!session || !agentAddress) return;
    setBusy(true); setError(null);
    try {
      // Use the agent's naming-service name by default — don't make the member type a display name (they can
      // still override via the optional field). Falls back to a short address label only if unnamed.
      const displayName = joinName.trim() || agentName || `member-${agentAddress.slice(2, 8)}`;
      // Route the signer by the home's ACTUAL credential (a KMS home must not pop a passkey/wallet).
      const sign = await signHashFor(resolveVia(homeProfile?.credential, session.via), agentAddress as Address, { token: session.token });
      const listing = await issueDirectoryListing(agentAddress as Address, sign, {
        communityId,
        displayName,
      });
      const res = await fetch('/connect/directory', {
        method: 'POST', headers: authed,
        body: JSON.stringify({ action: 'publish', listing }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `join failed (${res.status})`);
      // spec 322 W3d — enable the MEMBER's own interactions plane when it costs no extra device
      // prompt (KMS homes sign server-side), so the write-through below lands in their vault.
      // Prompt-requiring credentials skip here (value steps ≠ signatures) — their doc catches up
      // at their own enable ceremony.
      const joinVia = resolveVia(homeProfile?.credential, session.via);
      if (isKmsVia(joinVia)) await activateInteractionsIfNeeded(agentAddress as Address, joinVia, { token: session.token }).catch(() => null);
      // spec 321 W1/W2b — every join path mints the membership delegation (member→org); the server
      // also attaches any steward-pre-signed member-access grant stored for this SA (in-app invites).
      await recordOrgMembership(agentAddress as Address, communityId, sign, session.token, null, displayName);
      await load();
      // The join added this org to the member's tree — reload every dropdown/list instance NOW (the
      // triggered related-orgs read also runs the org-name self-heal, so it arrives named, not 0x…).
      notifyAgentsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [session, homeProfile?.credential, agentAddress, agentName, joinName, communityId, authed, load]);

  // spec 324 §7/§12 — a non-member REQUESTS to join (a MembershipApplication delivered to the org's inbox); a
  // steward approves/rejects from Members. The listing is published as a CONSEQUENCE of enrollment (join()
  // below), not the join mechanism itself.
  const apply = useCallback(async () => {
    if (!session) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/connect/inbox', {
        method: 'POST', headers: authed,
        body: JSON.stringify({ action: 'apply', org: communityId, bodyText: applyMessage.trim() || 'Requesting to join this organization.' }),
      });
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !b.ok) throw new Error(b.error ?? `request failed (${res.status})`);
      setApplied(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [session, authed, communityId, applyMessage]);

  const createChannel = useCallback(async () => {
    if (!newTitle.trim()) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/connect/channels', {
        method: 'POST', headers: authed,
        body: JSON.stringify({
          // Open — every organization member participates automatically. Restricted — invite-only
          // (custodian-created); participants are then invited per topic.
          action: 'create', communityId, title: newTitle.trim(), participationPolicy: newPolicy,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; channelId?: string; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `create failed (${res.status})`);
      setNewTitle(''); setCreating(false); setNewPolicy('open');
      await load();
      if (body.channelId) setActive(body.channelId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [newTitle, newPolicy, communityId, authed, load]);

  // Participants of the active RESTRICTED topic (open topics derive from membership — no fetch).
  const activePolicy = useMemo(() => {
    const c = channels?.find((ch) => ch.descriptor.id === active);
    return c?.participationPolicy ?? 'open';
  }, [channels, active]);

  const loadParticipants = useCallback(async () => {
    if (!active || activePolicy !== 'restricted') { setParticipants(null); setPendingInvites([]); return; }
    try {
      const res = await fetch('/connect/channels', {
        method: 'POST', headers: authed,
        body: JSON.stringify({ action: 'participants', communityId, channelId: active }),
      });
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; participants?: ParticipantRow[]; pendingInvites?: PendingInviteRow[] };
      if (res.ok && b.ok) { setParticipants(b.participants ?? []); setPendingInvites(b.pendingInvites ?? []); }
    } catch { /* rail stays empty */ }
  }, [active, activePolicy, communityId, authed]);

  useEffect(() => { void loadParticipants(); }, [loadParticipants]);
  // Close the participant-invite popover + clear its filter whenever the active topic changes.
  useEffect(() => { setTopicInviteOpen(false); setTopicInviteFilter(''); }, [active]);

  const inviteParticipant = useCallback(async (personSA: string, personName: string) => {
    if (!active) return;
    setParticipantBusy(personSA); setError(null);
    try {
      const res = await fetch('/connect/channels', {
        method: 'POST', headers: authed,
        body: JSON.stringify({ action: 'invite', communityId, channelId: active, personSA, personName }),
      });
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; topicTitle?: string };
      if (!res.ok || !b.ok) throw new Error(b.error ?? `invite failed (${res.status})`);
      // Deliver the invitation to the person's Home inbox with the discussion-topic contextRef —
      // Messages renders it as a "Join discussion" chip (acceptInvite).
      const nameForSend = listings.find((l) => l.listing.subject.toLowerCase().endsWith(personSA.toLowerCase()))?.label;
      if (nameForSend) {
        await fetch('/connect/inbox', {
          method: 'POST', headers: authed,
          body: JSON.stringify({
            action: 'send', toLabel: nameForSend,
            bodyText: `You're invited to the restricted discussion topic "${b.topicTitle ?? ''}". Open the chip on this message to join.`,
            // id carries org + topic (`<orgSA>/<topicId>`) — ContextRefV1 has no extra fields; the
            // Messages chip splits it to acceptInvite + deep-link.
            contextRefs: [{ kind: 'discussion-topic', id: `${communityId}/${active}`, label: b.topicTitle ?? 'Join discussion' }],
          }),
        }).catch(() => null);
      }
      await loadParticipants();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setParticipantBusy(null); }
  }, [active, communityId, authed, listings, loadParticipants]);

  const revokeParticipant = useCallback(async (personSA: string) => {
    if (!active) return;
    setParticipantBusy(personSA); setError(null);
    try {
      const res = await fetch('/connect/channels', {
        method: 'POST', headers: authed,
        body: JSON.stringify({ action: 'revokeParticipant', communityId, channelId: active, personSA }),
      });
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !b.ok) throw new Error(b.error ?? `revoke failed (${res.status})`);
      await loadParticipants();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setParticipantBusy(null); }
  }, [active, communityId, authed, loadParticipants]);

  const enableOrgVault = useCallback(async () => {
    if (!session || !agentAddress || !DELIVERY_SERVICE_SA) return;
    setBusy(true); setError(null);
    try {
      // Route the signer by the home's ACTUAL credential (resolveVia), NOT raw session.via — a social/KMS
      // connected custodian signs the enable ceremony SERVER-SIDE (no passkey prompt). Matches join() above;
      // the old raw-via path popped a passkey for KMS/social homes (sign-by-credential-not-via).
      const via = resolveVia(homeProfile?.credential, session.via);
      const auth = isKmsVia(via) ? { token: session.token } : undefined;
      const bound = await activateVaultIfNeeded(org, via, auth);
      if (!bound.ok) throw new Error(bound.error);
      const grant = await activateInboxDeliveryIfNeeded(org, via, auth);
      if (!grant.ok) throw new Error(grant.error);
      // spec 322 W2.2 — the interactions grant (plane B) rides the same enable ceremony; inert
      // until INTERACTIONS_SERVICE_SA is provisioned.
      const ix = await activateInteractionsIfNeeded(org, via, auth);
      if (!ix.ok) console.warn('[channels] interactions grant not provisioned:', ix.error);
      setOrgVault(true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [session, homeProfile?.credential, agentAddress, org, load]);

  const postMessage = useCallback(async (body: string) => {
    if (!active || !body.trim()) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/connect/channels', {
        method: 'POST', headers: authed,
        body: JSON.stringify({ action: 'post', communityId, channelId: active, bodyText: body.trim() }),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !out.ok) throw new Error(out.error ?? `post failed (${res.status})`);
      setDraft('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [active, communityId, authed, load]);

  const searchInvitees = useCallback(async () => {
    if (!inviteQuery.trim()) return;
    setInviteHits(await searchAgentsKb(inviteQuery.trim()).catch(() => []));
  }, [inviteQuery]);

  const [inviteBusyFor, setInviteBusyFor] = useState<string | null>(null);
  const invite = useCallback(async (hit: AgentSearchHit) => {
    if (!session) return;
    setBusy(true); setInviteBusyFor(hit.name); setError(null); setInviteSent(null);
    let grantNote = '';
    try {
      // spec 321 W2b — same as the org Invite page: pre-sign the org→invitee member-access grant and
      // store it in the org vault so /connect/org-membership attaches it when they join. Best-effort —
      // a non-steward's sign fails (only the org's custodian signs AS the org) and the chip still sends.
      try {
        const via = resolveVia(homeProfile?.credential, session.via);
        const sign = await signHashFor(via, org, { token: session.token });
        const mad = toWire(await issueOrganizationResourceAccessDelegation(org, hit.smartAgent as Address, MCP_SERVER_ID, sign));
        const gr = await fetch('/connect/org-invite/agent', {
          method: 'POST', headers: authed,
          body: JSON.stringify({ org: communityId, agent: hit.smartAgent.toLowerCase(), memberAccessDelegation: mad }),
        });
        const gb = (await gr.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!gr.ok || !gb.ok) throw new Error(gb.error ?? `grant store failed (${gr.status})`);
      } catch (e) {
        grantNote = ` (without a pre-signed access grant: ${e instanceof Error ? e.message : String(e)})`;
      }
      const res = await fetch('/connect/inbox', {
        method: 'POST', headers: authed,
        body: JSON.stringify({
          action: 'send',
          toName: hit.name,
          bodyText:
            `You're invited to join this organization's discussions. ` +
            `Open the invitation chip on this conversation to join — you'll sign a listing you can revoke anytime.`,
          contextRefs: [{ kind: 'org-channels', id: communityId, label: 'Join the discussion' }],
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `invite failed (${res.status})`);
      setInviteSent((hit.displayName ?? hit.name) + grantNote);
      setInviteQuery(''); setInviteHits(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); setInviteBusyFor(null); }
  }, [session, homeProfile?.credential, org, authed, communityId]);

  const listingBySubject = useMemo(() => {
    const m = new Map<string, Listing>();
    for (const l of listings) m.set(l.listing.subject.toLowerCase(), l);
    return m;
  }, [listings]);

  // SEC-H1 regression fix: steward access (via the stewardship wire) no longer implies a member
  // LISTING — a steward can read/create channels while absent from the directory (Members · 0, no way
  // to be messaged). Compute whether THIS person already has a listing; if a steward isn't listed, the
  // main view offers a self-add CTA (the member===false join card never shows for them, since the
  // server returns member=true). Listing subjects are CAIP-10 (`eip155:<chain>:0x…`) → match by suffix.
  const youAreListed = useMemo(() => {
    const me = (agentAddress ?? '').toLowerCase();
    return !!me && listings.some((l) => l.listing.subject.toLowerCase().endsWith(me));
  }, [listings, agentAddress]);

  // Prefill the self-add display name from the home's name once, when the CTA first applies.
  useEffect(() => {
    if (steward && member && !youAreListed && !joinName && agentName) setJoinName(agentName);
  }, [steward, member, youAreListed, joinName, agentName]);

  const openProfile = (name: string, label?: string, subject?: string) => {
    setProfile({
      name,
      label,
      subject,
      subtitle: label ? 'Member of this organization' : 'Not a current member',
      isYou: name === you,
    });
  };

  /** Telegram pattern: tap avatar or name in channel → DM slide-over, stay in channel context. */
  const openDm = (name: string, label?: string, subject?: string) => {
    if (name === you || !label) {
      openProfile(name, label, subject);
      return;
    }
    setDm({ name, label, subject });
  };

  const messageFromProfile = (t: ProfileTarget) => {
    setProfile(null);
    if (t.label) openDm(t.name, t.label, t.subject);
  };

  const channel = channels?.find((c) => c.descriptor.id === active) ?? null;

  if (!session || !agentAddress) return <SectionShell title="Discussions"><p>Not signed in.</p></SectionShell>;

  if (member === false) {
    return (
      <SectionShell title="Discussions" description="Topic discussion inside this organization">
        {/* spec 324 §12 — a non-member REQUESTS to join; membership is granted by a steward (enrollment), and
            the presence listing is published as a CONSEQUENCE of that (Complete membership, below). */}
        <div className="manage-card" style={{ maxWidth: 460, padding: '1.25rem' }}>
          <h3 className="subhead">Request to join this organization</h3>
          {applied ? (
            <p style={{ color: 'var(--color-sage-700, #047857)', fontSize: '0.85rem', margin: 0 }}>
              Application sent — a steward will review it. You&rsquo;ll get a message with a Join link when approved.
            </p>
          ) : (
            <>
              <p className="manage-card-blurb" style={{ margin: '0 0 0.8rem' }}>
                Membership is granted by a steward. Send a request — you&rsquo;ll be notified when it&rsquo;s reviewed.
              </p>
              <input
                placeholder="Add a note for the steward (optional)"
                value={applyMessage}
                onChange={(e) => setApplyMessage(e.target.value)}
                style={{ width: '100%', marginBottom: '0.6rem' }}
              />
              <button type="button" className="btn-primary" style={{ width: 'auto' }} disabled={busy} onClick={() => void apply()}>
                {busy ? 'Sending…' : 'Request to join'}
              </button>
            </>
          )}
          {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{error}</p>}
        </div>

        {/* After a steward approves, the applicant completes membership here — publishing the listing they sign
            (revocable). recordOrgMembership picks up the org→member grant the approval stored. */}
        <div className="manage-card" style={{ maxWidth: 460, padding: '1.25rem', marginTop: '0.85rem' }}>
          <h3 className="subhead">Approved? Complete your membership</h3>
          <p className="manage-card-blurb" style={{ margin: '0 0 0.8rem' }}>
            Once a steward approves your request, publish your listing to finish joining — members can see and
            message you here, and you can revoke it anytime.
          </p>
          <input
            placeholder={agentName ? `Display name (optional — defaults to ${agentName})` : 'Display name (optional)'}
            value={joinName}
            onChange={(e) => setJoinName(e.target.value)}
            style={{ width: '100%', marginBottom: '0.6rem' }}
          />
          <button type="button" className="btn" style={{ width: 'auto' }} disabled={busy} onClick={() => void join()}>
            {busy ? 'Signing…' : 'Sign & complete membership'}
          </button>
        </div>
      </SectionShell>
    );
  }

  return (
    <SectionShell title="Discussions" description="Topic discussion inside this organization">
      {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{error}</p>}

      {/* SEC-H1 regression fix — a steward can reach channels without a directory listing, so they show
          up as Members · 0 with no way to be seen/messaged. Offer an explicit self-add (publishes the
          steward's own signed listing via the same join() path). Members see the member===false card. */}
      {steward && member && !youAreListed && (
        <div className="chat-attention" style={{ marginBottom: '0.85rem' }}>
          <span style={{ fontSize: '0.85rem' }}>
            <b>You steward this organization but aren&rsquo;t listed as a member.</b> Add yourself so members can see and message you here.
          </span>
          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
            <input
              placeholder="Display name (how members see you)"
              value={joinName}
              onChange={(e) => setJoinName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void join(); }}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn-primary" style={{ width: 'auto', whiteSpace: 'nowrap' }} disabled={busy || !joinName.trim()} onClick={() => void join()}>
              {busy ? 'Signing…' : 'Add yourself as member'}
            </button>
          </div>
        </div>
      )}

      {orgAbout && (orgAbout.displayName || orgAbout.description) && (
        <div className="manage-card" style={{ marginBottom: '0.85rem', padding: '0.7rem 0.9rem' }}>
          <div style={{ fontSize: '0.85rem' }}>
            <b>{orgAbout.displayName ?? 'About this organization'}</b>
            {orgAbout.description && <span style={{ opacity: 0.75 }}> — {orgAbout.description}</span>}
            {orgAbout.website && <span style={{ opacity: 0.6 }}> · {orgAbout.website}</span>}
          </div>
          <p className="manage-card-blurb" style={{ margin: '0.2rem 0 0', fontSize: '0.72rem' }}>
            Read from the organization&rsquo;s vault over your member-access grant.
          </p>
        </div>
      )}

      {orgVault === false && (
        <div className="chat-attention" style={{ marginBottom: '0.85rem' }}>
          <span style={{ fontSize: '0.85rem' }}>
            <b>Discussion storage isn&rsquo;t enabled yet.</b> A steward authorizes the org vault once — then topics + posts are encrypted under the org&rsquo;s authority.
          </span>
          {/* Steward-only: the ceremony signs AS THE ORG — a member's credential can't (and the old
              always-shown button just failed them with sender_mismatch). */}
          {steward ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void enableOrgVault()} style={{ marginTop: '0.5rem' }}>
              {busy ? 'Signing…' : 'Enable (steward)'}
            </button>
          ) : (
            <span style={{ display: 'block', marginTop: '0.5rem', fontSize: '0.78rem', opacity: 0.8 }}>
              You&rsquo;re a member — ask one of this organization&rsquo;s stewards to enable it.
            </span>
          )}
        </div>
      )}

      <div className="channels-layout">
        <div className="channels-sidebar">
          <div className="channels-sidebar__title">
            <span>Topics</span>
            <button type="button" className="btn" style={{ padding: '0.1rem 0.5rem' }} disabled={orgVault === false} onClick={() => setCreating((v) => !v)} title="New topic">＋</button>
          </div>
          {creating && orgVault !== false && (
            <div style={{ marginBottom: '0.6rem', padding: '0 0.4rem' }}>
              <input
                placeholder="Topic, e.g. fundraising"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void createChannel(); }}
                style={{ width: '100%', marginBottom: '0.3rem' }}
              />
              {/* Participation policy: OPEN — every organization member participates automatically;
                  RESTRICTED — invite-only (custodian creates it, then invites participants). */}
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', margin: '0.2rem 0' }}>
                <input type="radio" name="topic-policy" checked={newPolicy === 'open'} onChange={() => setNewPolicy('open')} />
                Open — all organization members participate
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', margin: '0.2rem 0', opacity: steward ? 1 : 0.5 }}>
                <input type="radio" name="topic-policy" checked={newPolicy === 'restricted'} disabled={!steward} onChange={() => setNewPolicy('restricted')} />
                Restricted — invite-only{steward ? '' : ' (custodian only)'}
              </label>
              {newPolicy === 'restricted' && (
                <p style={{ fontSize: '0.72rem', opacity: 0.6, margin: '0.2rem 0' }}>
                  You&rsquo;ll be its first facilitator — invite participants from the topic&rsquo;s Participants panel after creating it.
                </p>
              )}
              <button type="button" className="btn" disabled={busy || !newTitle.trim()} onClick={() => void createChannel()}>
                {newPolicy === 'restricted' ? 'Create restricted topic' : 'Create'}
              </button>
            </div>
          )}
          {(channels ?? []).map((c) => (
            <button
              key={c.descriptor.id}
              type="button"
              className={`channels-sidebar__item${c.descriptor.id === active ? ' channels-sidebar__item--active' : ''}`}
              onClick={() => setActive(c.descriptor.id)}
              title={c.participationPolicy === 'restricted' ? 'Restricted topic — invite-only participation' : 'Open topic — all organization members participate'}
            >
              <span>{c.participationPolicy === 'restricted' ? '🔒 ' : ''}{c.title}</span>
              <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>{c.messages.length}</span>
            </button>
          ))}
          {channels && channels.length === 0 && !creating && (
            <p style={{ fontSize: '0.8rem', opacity: 0.6, padding: '0 0.4rem' }}>No topics yet.</p>
          )}
        </div>

        <div className="channels-feed">
          {channel ? (
            <>
              <div className="channels-feed-header">
                <AvatarUpload
                  name={channel.title}
                  imageUrl={communityAvatar}
                  size={44}
                  editable
                  onUpload={(url) => setCommunityAvatar(org, url)}
                />
                <div>
                  <strong># {channel.title}</strong>
                  <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
                    {channel.participationPolicy === 'restricted'
                      ? `Restricted · ${(participants ?? []).length} participants · ${channel.messages.length} messages`
                      : `Open · all ${listings.length} members participate · ${channel.messages.length} messages`}
                  </div>
                </div>
              </div>

              <div className="chat-thread-body" style={{ flex: 1 }}>
                {channel.messages.map((m, idx) => {
                  const l = listingBySubject.get(m.envelope.from.toLowerCase());
                  const mine = m.authorName === you;
                  const prev = channel.messages[idx - 1];
                  const next = channel.messages[idx + 1];
                  const firstOfGroup = !prev || prev.authorName !== m.authorName;
                  const lastOfGroup = !next || next.authorName !== m.authorName;

                  return (
                    <div
                      key={m.envelope.id}
                      style={{
                        display: 'flex',
                        gap: '0.5rem',
                        alignItems: 'flex-end',
                        flexDirection: mine ? 'row-reverse' : 'row',
                        marginTop: firstOfGroup ? '0.5rem' : 0,
                      }}
                    >
                      {!mine && (
                        lastOfGroup ? (
                          <button
                            type="button"
                            className="chat-poster-avatar-btn"
                            title={`Message ${m.authorName}`}
                            onClick={() => openDm(m.authorName, l?.label, l?.listing.subject)}
                          >
                            <PosterAvatar name={m.authorName} subject={l?.listing.subject} />
                          </button>
                        ) : (
                          <span style={{ width: 30, flex: 'none' }} />
                        )
                      )}
                      <MessageBubble
                        mine={mine}
                        body={bodies[m.envelope.id]}
                        time={timeShort(m.envelope.createdAt)}
                        authorName={m.authorName}
                        showAuthor={!mine}
                        firstOfGroup={firstOfGroup}
                        lastOfGroup={lastOfGroup}
                        onAuthorClick={() => openDm(m.authorName, l?.label, l?.listing.subject)}
                      />
                    </div>
                  );
                })}
                {channel.messages.length === 0 && (
                  <p style={{ fontSize: '0.85rem', opacity: 0.6, margin: 'auto', textAlign: 'center' }}>
                    Start the discussion in <b># {channel.title}</b>.
                  </p>
                )}
              </div>

              <MessageComposer
                value={draft}
                onChange={setDraft}
                onSend={postMessage}
                disabled={orgVault === false}
                busy={busy}
                placeholder={orgVault === false ? 'Enable discussion storage to post' : `Message # ${channel.title}`}
              />
            </>
          ) : (
            <p className="manage-card-blurb" style={{ margin: 'auto', padding: '2rem', textAlign: 'center' }}>{channels === null ? 'Loading…' : 'Pick or create a topic.'}</p>
          )}
        </div>

        <div className="channels-members">
          {/* Topic participants (restricted topics only). OPEN topics need no panel — every org member
              participates automatically (the Members directory below IS the participant list). */}
          {channel && activePolicy === 'restricted' && (() => {
            const me = (agentAddress ?? '').toLowerCase();
            const youFacilitator = steward || (participants ?? []).some((p) => p.personSA.toLowerCase() === me && p.role === 'facilitator');
            const participantSAs = new Set((participants ?? []).map((p) => p.personSA.toLowerCase()));
            const pendingSAs = new Set(pendingInvites.map((i) => i.invitedAgent.toLowerCase()));
            const invitable = listings
              .map((l) => ({ l, sa: (l.listing.subject.match(/0x[0-9a-fA-F]{40}/)?.[0] ?? '').toLowerCase() }))
              .filter(({ sa }) => sa && !participantSAs.has(sa) && !pendingSAs.has(sa));
            // A participant's DM target comes from their DIRECTORY listing (label = agent name) —
            // the participation row only carries a display name.
            const listingForSa = (sa: string) => listings.find((l) => l.listing.subject.toLowerCase().endsWith(sa.toLowerCase()));
            return (
              <div style={{ marginBottom: '0.9rem' }}>
                <div className="channels-sidebar__title">
                  <span>Participants · {(participants ?? []).length + pendingInvites.length}</span>
                  {youFacilitator && (
                    <button type="button" className="btn" style={{ padding: '0.1rem 0.5rem' }} title="Invite a participant to this topic" onClick={() => setTopicInviteOpen((v) => !v)}>＋</button>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', padding: '0 0.25rem' }}>
                  {(participants ?? []).map((p) => {
                    const pl = listingForSa(p.personSA);
                    const pName = p.personName ?? pl?.listing.displayName ?? `${p.personSA.slice(0, 8)}…`;
                    const isMe = p.personSA.toLowerCase() === me;
                    return (
                      <div key={p.personSA} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem' }}>
                        <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <b>{pName}</b>
                          <span style={{ opacity: 0.55 }}> · {p.role}{isMe ? ' (you)' : ''}</span>
                        </span>
                        {/* One-to-one MESSAGING (not discussion): same DM slide-over as the Members rail. */}
                        {!isMe && pl && (
                          <button type="button" className="btn" style={{ padding: '0 0.35rem', fontSize: '0.7rem' }} title={`Message ${pName}`} onClick={() => openDm(pl.listing.displayName, pl.label, pl.listing.subject)}>
                            ✉
                          </button>
                        )}
                        {youFacilitator && !isMe && (
                          <button type="button" className="btn" style={{ padding: '0 0.35rem', fontSize: '0.7rem' }} disabled={participantBusy === p.personSA} onClick={() => void revokeParticipant(p.personSA)}>
                            Remove
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {pendingInvites.map((i) => (
                    <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', opacity: 0.65 }}>
                      <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {i.invitedName ?? `${i.invitedAgent.slice(0, 8)}…`} · invited
                      </span>
                      {youFacilitator && (
                        <button type="button" className="btn" style={{ padding: '0 0.35rem', fontSize: '0.7rem' }} disabled={participantBusy === i.invitedAgent} onClick={() => void revokeParticipant(i.invitedAgent)}>
                          Cancel
                        </button>
                      )}
                    </div>
                  ))}
                  {(participants ?? []).length === 0 && pendingInvites.length === 0 && (
                    <p style={{ fontSize: '0.75rem', opacity: 0.6, padding: '0.25rem' }}>
                      No participants yet{youFacilitator ? ' — use ＋ to invite organization members.' : ''}
                    </p>
                  )}
                </div>

                {/* Invite popover — filterable roster of EXISTING org members not already participating.
                    Bringing a NEW person into the organization is membership management (Members), never a
                    topic act, so this only selects among current members. */}
                {youFacilitator && topicInviteOpen && (() => {
                  const q = topicInviteFilter.trim().toLowerCase();
                  const shown = invitable.filter(({ l }) =>
                    !q || (l.listing.displayName ?? '').toLowerCase().includes(q) || (l.label ?? '').toLowerCase().includes(q));
                  return (
                    <div
                      role="dialog"
                      onClick={(e) => { if (e.target === e.currentTarget) setTopicInviteOpen(false); }}
                      style={{ position: 'fixed', inset: 0, background: 'rgba(20,30,42,.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 60, padding: '8vh 1rem' }}
                    >
                      <div style={{ background: 'var(--color-surface, #fff)', borderRadius: 14, boxShadow: '0 22px 64px rgba(0,0,0,.32)', width: '100%', maxWidth: 440, maxHeight: '76vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                        <div style={{ display: 'flex', alignItems: 'center', padding: '0.9rem 1.1rem', borderBottom: '1px solid var(--color-border, #e5e7eb)' }}>
                          <b>Invite a participant</b>
                          <button type="button" className="btn" style={{ marginLeft: 'auto', padding: '0 0.5rem', fontSize: '1.1rem', lineHeight: 1 }} title="Close" onClick={() => setTopicInviteOpen(false)}>×</button>
                        </div>
                        <div style={{ padding: '0.75rem 1.1rem 0.5rem' }}>
                          <input
                            placeholder="Filter members…"
                            value={topicInviteFilter}
                            onChange={(e) => setTopicInviteFilter(e.target.value)}
                            style={{ width: '100%', padding: '0.5rem 0.85rem', border: '1px solid var(--color-border, #e5e7eb)', borderRadius: 999 }}
                          />
                          <p style={{ fontSize: '0.7rem', opacity: 0.6, margin: '0.4rem 0 0' }}>
                            Only current members can be invited to a topic. To add someone new, use{' '}
                            <a href={`/org/${communityId}/members`}>Members</a>.
                          </p>
                        </div>
                        <div style={{ overflowY: 'auto', padding: '0 0.6rem 0.6rem' }}>
                          {invitable.length === 0 ? (
                            <p style={{ fontSize: '0.78rem', opacity: 0.6, padding: '0.5rem' }}>Everyone is already a participant.</p>
                          ) : shown.length === 0 ? (
                            <p style={{ fontSize: '0.78rem', opacity: 0.6, padding: '0.5rem' }}>No members match &ldquo;{topicInviteFilter.trim()}&rdquo;.</p>
                          ) : shown.map(({ l, sa }) => (
                            <div key={sa} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.4rem', borderBottom: '1px solid var(--color-border, #f1f1f1)' }}>
                              <MemberAvatar listing={l} />
                              <span style={{ minWidth: 0, flex: 1, fontSize: '0.83rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.listing.displayName}</span>
                              <BusyButton busy={participantBusy === sa} busyLabel="…" className="btn-primary" style={{ width: 'auto', padding: '0.2rem 0.7rem', fontSize: '0.75rem' }} onClick={() => void inviteParticipant(sa, l.listing.displayName)}>Invite</BusyButton>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })()}
          {channel && activePolicy === 'open' && (
            <p style={{ fontSize: '0.72rem', opacity: 0.6, padding: '0 0.25rem', margin: '0 0 0.5rem' }}>
              Open topic — all organization members participate.
            </p>
          )}
          <div className="channels-sidebar__title">
            <span>Members · {listings.length}</span>
            {/* MEMBERSHIP management entry (steward act) — visibly distinct from the topic-invite
                panel above: this brings a NEW person into the ORGANIZATION, not into a topic. */}
            {steward && (
              <button type="button" className="btn" style={{ padding: '0.1rem 0.5rem' }} onClick={() => setInviteOpen((v) => !v)} title="Invite someone to join this organization (membership)">＋</button>
            )}
          </div>
          {inviteOpen && steward && (
            <div style={{ margin: '0.25rem 0 0.5rem', padding: '0.4rem 0.25rem', borderLeft: '2px solid var(--color-amber-400, #f59e0b)' }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 600, marginBottom: '0.2rem' }}>Organization membership invite</div>
              <p style={{ fontSize: '0.68rem', opacity: 0.6, margin: '0 0 0.35rem' }}>
                Invites a person to <b>join this organization</b> (they sign their own revocable listing).
                For email invites and roster management, use <a href={`/org/${communityId}/members`}>Members</a>.
              </p>
              <input
                placeholder="Find a person…"
                value={inviteQuery}
                onChange={(e) => setInviteQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void searchInvitees(); }}
                style={{ width: '100%', marginBottom: '0.3rem' }}
              />
              {inviteHits?.map((h) => (
                <div key={h.name} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: 2 }}>
                  <div style={{ minWidth: 0, flex: 1, fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <b>{h.displayName ?? h.label}</b>
                  </div>
                  <BusyButton busy={inviteBusyFor === h.name} busyLabel="Signing…" style={{ padding: '0 0.4rem', fontSize: '0.72rem' }} disabled={busy} onClick={() => void invite(h)}>Invite to organization</BusyButton>
                </div>
              ))}
              {inviteSent && <p style={{ fontSize: '0.75rem', color: 'var(--color-sage-700)' }}>Invitation sent to {inviteSent}.</p>}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
            {listings.map((l) => (
              <div key={l.listing.subject} className="channels-member-row">
                <button
                  type="button"
                  className="channels-member-row__main"
                  aria-label={
                    l.listing.displayName === you
                      ? 'Your profile'
                      : `Message ${l.listing.displayName}`
                  }
                  onClick={() =>
                    l.listing.displayName === you
                      ? openProfile(l.listing.displayName, l.label, l.listing.subject)
                      : openDm(l.listing.displayName, l.label, l.listing.subject)
                  }
                >
                  <MemberAvatar listing={l} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: '0.83rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {l.listing.displayName}{l.listing.displayName === you ? ' (you)' : ''}
                    </div>
                    <div style={{ fontSize: '0.72rem', opacity: 0.55 }}>{l.label}</div>
                  </div>
                  {l.listing.displayName !== you && (
                    <span className="channels-member-row__hint" aria-hidden>✉</span>
                  )}
                </button>
                <button
                  type="button"
                  className="channels-member-row__info"
                  title="View profile"
                  onClick={() => openProfile(l.listing.displayName, l.label, l.listing.subject)}
                >
                  ⋯
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <ProfileSheet target={profile} onClose={() => setProfile(null)} onMessage={messageFromProfile} />

      {session && dm && (
        <DmSlideOver
          session={session}
          recipientName={dm.name}
          recipientLabel={dm.label}
          recipientSubject={dm.subject}
          channelContext={channel ? { channelTitle: channel.title } : undefined}
          onClose={() => setDm(null)}
        />
      )}
    </SectionShell>
  );
}
