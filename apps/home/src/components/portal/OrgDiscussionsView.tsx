'use client';
// Org Discussions (spec 324 §10) — the org's forum-profile Conversation, presented as Topics (Telegram-forum
// shape: each Topic is a DiscussionTopic inside the org's discussion space, NOT a sibling conversation) with a
// Telegram-style member→DM slide-over, group avatars, rich messages (emoji + images), amber design system.
// NOTE: the internal transport keys (`/connect/channels`, `channelId`, `communityId`, CSS `channels-*`) are
// unchanged pending the W6 record-key migration; only the user-facing vocabulary is Discussions/Topics here.
import { MailIcon } from '../shared/Icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HuddleAffordance } from './huddle/HuddleDock';
import type { Address } from '@agenticprimitives/types';
import type { MessageEnvelopeV1 } from '@agenticprimitives/fabric/messaging';
import { useSession } from '../../context/session';
import { sendMessage, MessagingWireRequiredError } from '../../lib/messaging-send';
import { membersFromReceivedDelegations, type RosterMember } from '../../lib/recipient-directory';
import { ApproveMessaging } from './ApproveMessaging';
import { agentNameForLabel } from '../../lib/domain';
import { SkeletonRows, EmptyState, useReadyReport } from '../../ui';
import { HashIcon as HashGlyph, LockIcon as LockGlyph } from '../shared/Icons';
import { SectionShell } from './SectionShell';
import { issueDirectoryListing } from '../../home/directory';
import { activateVaultIfNeeded, activateInboxDeliveryIfNeeded, activateInteractionsIfNeeded, isKmsVia, resolveVia, signHashFor, type Via } from '../../home/onboarding';
import { joinOrganization } from '../../home/join-organization';
import { provisionCommunityMessaging } from '../../lib/messaging-ceremony';
import { notifyAgentsChanged } from './ManagedAgents';
import { vaultReadWithDelegation } from '../../lib/vault-client';
import { ORG_INTERACTIONS_SESSION_LEAF_TTL_SECONDS, type DelegationWire } from '../../lib/delegation';
import { DELIVERY_SERVICE_SA } from '../../lib/inbox-delivery';
import { BusyButton } from '../shared/BusyButton';
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

// `actor` (spec 327 / spec 324 §9): acting-agent provenance — set on org-assistant posts; drives the "agent" badge.
interface ChannelMessage { envelope: MessageEnvelopeV1; authorName: string; actor?: string }
// participationPolicy (tbox/messaging.ttl): open — every org MEMBER participates automatically (derived
// from membership; no stored list); restricted — invite-only, participation asserted per person.
// assistant (spec 327): steward-enabled org-assistant participation on this topic.
// routing (spec 329): steward-enabled member routing — the assistant may consult opted-in member agents.
interface Channel { descriptor: { id: string; owner: string }; title: string; createdBy: string; messages: ChannelMessage[]; participationPolicy?: 'open' | 'restricted'; assistant?: { trigger: 'mention' | 'all'; mentionHandle: string; displayName: string }; routing?: { maxFanout: number } }
// `orgRole` (spec 329 §12) is the member's own signed, org-scoped primary role — display only here;
// the org's assistant routes role-addressed questions on the same field.
interface Listing { listing: { subject: string; displayName: string; communityId: string; orgRole?: string }; label: string }
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
  const [wireNeeded, setWireNeeded] = useState<MessagingWireRequiredError | null>(null);
  // A REF, because `load` is a useCallback whose deps are [session, communityId, authed, active] — it does
  // NOT re-memoize when `wireNeeded` changes, so reading the state inside it would capture the value from
  // the render that created it (null) and clear the error anyway. A guard that is always true is worse
  // than no guard: it reads as fixed. Adding `wireNeeded` to the deps would work too, but re-fires the
  // `useEffect(() => void load(), [load])` poll on every change, so a ref is the cheaper correct answer.
  const wireNeededRef = useRef<MessagingWireRequiredError | null>(null);
  const noteWireNeeded = useCallback((e: MessagingWireRequiredError | null) => {
    wireNeededRef.current = e;
    setWireNeeded(e);
  }, []);
  const communityId = org.toLowerCase();
  const communityAvatar = useAvatar(communityAvatarKey(org));

  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [orgVault, setOrgVault] = useState<boolean | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  /** Members known from the steward's received-delegations index — those who joined by invite and never
   *  published a directory listing. Membership has TWO projections and this view only ever read one. */
  const [invited, setInvited] = useState<RosterMember[]>([]);
  /** The SERVER's answer to "is this person a member here" — it comes back on the channels read that
   *  this view already makes. The view had been deciding membership itself from directory listings,
   *  which is a narrower question: whether you published your own listing. */
  const [linked, setLinked] = useState(false);
  const [you, setYou] = useState<string | null>(null);
  const [member, setMember] = useState<boolean | null>(null);
  // LOADING until we know whether this person is a member — then done. A NON-member's page has no channels to wait for:
  // reporting `channels === null` as loading kept "Reading…" on forever for everyone the organization had not admitted
  // (ezra.me, invited, live 2026-09-29 — "it just spins").
  useReadyReport('discussions-channels', member === null || (member === true && channels === null));
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
  /** This person holds the organization's invitation (its member-access grant) — the page leads with Join, not Request. */
  const [invitedToJoin, setInvitedToJoin] = useState(false);
  const [participantBusy, setParticipantBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
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
    // BOTH projections of membership, always — a union, never a fallback (ADR-0013, and the same pair
    // `fetchRoster` reads). A directory listing is the member's OWN self-signed row; the
    // received-delegations index holds the members who joined by invite and never published one. Reading
    // only the directory made an invited member invisible here: Participants · 0 on a topic whose own
    // history says they joined, and a steward told forever to "add yourself as member".
    const [chRes, dirRes, recRes] = await Promise.all([
      fetch(`/connect/channels?communityId=${communityId}${qs}`, { headers: authed }),
      fetch(`/connect/directory?communityId=${communityId}`, { headers: authed }),
      fetch('/connect/received-delegations', { headers: authed }),
    ]);
    if (dirRes.ok) {
      const d = (await dirRes.json()) as { listings?: Listing[] };
      setListings(d.listings ?? []);
    }
    if (recRes.ok) {
      const rec = (await recRes.json().catch(() => ({}))) as Parameters<typeof membersFromReceivedDelegations>[0];
      setInvited(membersFromReceivedDelegations(rec, communityId));
    }
    if (chRes.status === 403) {
      // Non-member: the enrollment card (Request to join / Complete membership) IS the explanation now (spec
      // §12). Don't leak the DO's old listing-first gate message ("publish a directory listing to enter") into
      // it — that framing contradicts request→approve→complete. Clear any stale error too.
      // Clears the DO's stale listing-first message — but NOT a refusal the applicant still has to act
      // on. `apply` sets `wireNeeded`, and this poll runs every few seconds while a non-member sits on
      // this exact card, so an unconditional clear erased the only feedback they had. The approval
      // affordance survives because it lives in `wireNeeded`, not in `error`; the guard keeps a genuine
      // apply error visible too.
      const nb = (await chRes.json().catch(() => ({}))) as { invited?: boolean };
      setInvitedToJoin(nb.invited === true);
      setMember(false); setChannels(null);
      if (!wireNeededRef.current) setError(null);
      return;
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
    setLinked(c.membership === 'linked');
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
    // A NON-member has no topic to follow — the page only watches for their join/approval, so it polls far less (three
    // 1–3 s reads every 12 s kept an invitee's page churning for nothing — live 2026-09-29).
    const t = setInterval(() => void load(), member === false ? 45000 : 12000);
    return () => clearInterval(t);
  }, [load, member]);

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
      // THE ceremony — shared with the Ask's accept (spec 421): listing, interactions plane, membership, messaging.
      await joinOrganization({ member: agentAddress as Address, org: communityId, displayName, session, credential: homeProfile?.credential, named: !!agentName?.trim() });
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
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      // APPLYING RIDES THE MESSAGING WIRE (spec 341 §5.5a), so it can be refused for the same resolvable
      // reason a first message is: no wire yet. That is a request for the one-prompt ceremony, NOT a
      // failure — and this path used to turn it into a bare `Error`, so `wireNeeded` stayed null, the
      // `ApproveMessaging` affordance below never rendered, and the applicant was left pressing a button
      // that did nothing. Worse, the 403 poll clears `error` a few seconds later, so even the message
      // disappeared: a silent dead end on the only route into an organization.
      //
      // Routed through the same error the send helper raises, so the affordance is the one every other
      // send already uses rather than a second one that can drift from it.
      if (b.code === 'wire_absent' || b.code === 'recipient_not_in_wire') {
        noteWireNeeded(new MessagingWireRequiredError(
          b.code as 'wire_absent' | 'recipient_not_in_wire',
          typeof b.recipient === 'string' ? (b.recipient as Address) : undefined,
          Array.isArray(b.recipients) ? (b.recipients as Address[]) : [],
          typeof b.sessionKey === 'string' ? (b.sessionKey as Address) : undefined,
          String(b.error ?? 'approve messaging to send your request'),
        ));
        return;
      }
      if (!res.ok || b.ok !== true) throw new Error(String(b.error ?? `request failed (${res.status})`));
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
        // spec 341 §5.1b — the steward's own agent delivers the invitation over A2A. Best-effort as
        // before: the participant record already stands, so a send failure does not undo the invite.
        if (agentAddress) {
          await sendMessage({
            person: agentAddress,
            recipientName: agentNameForLabel(nameForSend),
            bodyText: `You're invited to the restricted discussion topic "${b.topicTitle ?? ''}". Open the chip on this message to join.`,
            // id carries org + topic (`<orgSA>/<topicId>`) — ContextRefV1 has no extra fields; the
            // Messages chip splits it to acceptInvite + deep-link.
            contextRefs: [{ kind: 'discussion-topic', id: `${communityId}/${active}`, label: b.topicTitle ?? 'Join discussion' }],
          }).catch((e: unknown) => {
            // Best-effort as before — the participant record already stands. But an approval-shaped
            // failure is offered rather than swallowed: the steward can fix it and re-invite.
            if (e instanceof MessagingWireRequiredError) noteWireNeeded(e);
          });
        }
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
      // Token always passed — KMS and demo-account homes both sign server-side with it.
      const auth = { token: session.token };
      const bound = await activateVaultIfNeeded(org, via, auth);
      if (!bound.ok) throw new Error(bound.error);
      const grant = await activateInboxDeliveryIfNeeded(org, via, auth);
      if (!grant.ok) throw new Error(grant.error);
      // spec 322 W2.2 — the interactions grant (plane B) rides the same enable ceremony; inert
      // until INTERACTIONS_SERVICE_SA is provisioned.
      const ix = await activateInteractionsIfNeeded(org, via, auth, false, ORG_INTERACTIONS_SESSION_LEAF_TTL_SECONDS);
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
      // spec 327 — the reply arrives asynchronously (the org's own agent posts it server-side).
      // Bounded cosmetic follow-up polls so it appears without a manual reload; detection stays
      // entirely server-side — this only refreshes the view when a reply is plausibly coming.
      const a = channels?.find((c) => c.descriptor.id === active)?.assistant;
      const mentioned = a && (a.trigger === 'all' || /(?:^|[^a-z0-9-])@ask(?![a-z0-9-])/i.test(body) || (a.mentionHandle && new RegExp(`@${a.mentionHandle}\\b`, 'i').test(body)));
      if (mentioned) { setTimeout(() => void load(), 3500); setTimeout(() => void load(), 8000); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [active, communityId, authed, load, channels]);

  // spec 327/329 — the org's discussion assistant and member routing are ALWAYS ON; there is no
  // per-topic toggle here (the org configures its bot once in Manage → Agent). Reconcile silently
  // for a steward: enable the assistant on any topic missing it, and enable member routing wherever
  // the org's consult wire is already set up (the one-time signing lives in Manage → Agent, never on
  // the board). Idempotent + tracked per topic, so a benign failure (a nameless org can't be
  // @-mentioned; the wire isn't set up yet) is not retried in a loop. One write per pass; `load()`
  // refreshes and the guard refs converge.
  const autoAsstRef = useRef<Set<string>>(new Set());
  const autoRouteRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!steward || orgVault !== true || !channels) return;
    let cancelled = false;
    void (async () => {
      for (const c of channels) {
        const id = c.descriptor.id;
        if (!c.assistant && !autoAsstRef.current.has(id)) {
          autoAsstRef.current.add(id);
          try {
            const r = await fetch('/connect/channels', { method: 'POST', headers: authed, body: JSON.stringify({ action: 'assistantEnable', communityId, channelId: id, trigger: 'mention' }) });
            const b = (await r.json().catch(() => ({}))) as { ok?: boolean };
            if (r.ok && b.ok && !cancelled) { await load(); return; }
          } catch { /* silent — the status chip just won't show the bot yet */ }
        }
        if (c.assistant && !c.routing && !autoRouteRef.current.has(id)) {
          autoRouteRef.current.add(id);
          try {
            const r = await fetch('/connect/channels', { method: 'POST', headers: authed, body: JSON.stringify({ action: 'routingEnable', communityId, channelId: id, maxFanout: 3 }) });
            const b = (await r.json().catch(() => ({}))) as { ok?: boolean };
            if (r.ok && b.ok && !cancelled) { await load(); return; }
          } catch { /* wire not set up yet — the steward turns it on in Manage → Agent */ }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [steward, orgVault, channels, communityId, authed, load]);

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
  /** Every member of this organization, from both projections — the roster this view should have used
   *  all along. Addresses only; the listing map above still supplies the richer labels. */
  const memberAddresses = useMemo(() => {
    const out = new Set<string>();
    for (const l of listings) {
      const a = l.listing.subject.toLowerCase().match(/0x[0-9a-f]{40}/)?.[0];
      if (a) out.add(a);
    }
    for (const m of invited) out.add(m.address.toLowerCase());
    return out;
  }, [listings, invited]);

  // "Are you a member here" — the server said so on the channels read (`membership: 'linked'`), and a
  // published listing says so too. Deciding it from listings ALONE told a linked member, in an
  // organization where nobody has published a listing, to add themselves — forever, with no effect on
  // the thing they were actually being asked about.
  const youAreListed = useMemo(() => {
    const me = (agentAddress ?? '').toLowerCase();
    return linked || (!!me && memberAddresses.has(me));
  }, [memberAddresses, agentAddress, linked]);

  /** A steward who is not in their own organization's directory is a state nobody chose — they created
   *  or were given the org, and the listing simply was never published. Asking them to "add yourself as
   *  member", every visit, is the app reporting its own bookkeeping as a task.
   *
   *  So we do it for them WHEN IT IS FREE. Publishing a listing is signed, and on a passkey or wallet
   *  home that is a device prompt — firing one on page load would be a ceremony nobody asked for, which
   *  is the rule this file already follows two lines into `join()` ("value steps ≠ signatures"). On a
   *  KMS/social home the signature is server-side and invisible, so it just happens; anywhere else the
   *  offer below stands and one click does it.
   *
   *  Attempted at most once per organization per mount: a failure must not become a signing loop. */
  const autoJoined = useRef<string | null>(null);
  useEffect(() => {
    if (!steward || !member || youAreListed || busy) return;
    if (!session || !agentAddress || autoJoined.current === communityId) return;
    if (!isKmsVia(resolveVia(homeProfile?.credential, session.via))) return;
    autoJoined.current = communityId;
    void join();
  }, [steward, member, youAreListed, busy, session, agentAddress, communityId, homeProfile?.credential, join]);

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

  // Keep the thread pinned to the LATEST message. `atBottomRef` tracks (via onScroll) whether the
  // reader is stuck to the bottom BEFORE new content lands — measuring after the DOM grew would
  // read as "not at bottom" and never re-pin. On topic (re)open we force a jump; otherwise we only
  // follow when the reader was already at the bottom, and we scroll in rAF so the newly-rendered
  // messages/bodies are laid out first.
  const threadRef = useRef<HTMLDivElement | null>(null);
  const lastTopicRef = useRef<string | null>(null);
  const atBottomRef = useRef(true);
  const onThreadScroll = useCallback(() => {
    const el = threadRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);
  const msgCount = channel?.messages.length ?? 0;
  useEffect(() => {
    if (!channel) return;
    const topicChanged = lastTopicRef.current !== channel.descriptor.id;
    lastTopicRef.current = channel.descriptor.id;
    if (topicChanged) atBottomRef.current = true;
    if (!(topicChanged || atBottomRef.current)) return;
    requestAnimationFrame(() => {
      const el = threadRef.current;
      if (el) { el.scrollTop = el.scrollHeight; atBottomRef.current = true; }
    });
  }, [channel, msgCount, bodies]);

  if (!session || !agentAddress) return <SectionShell title="Discussions"><p>Not signed in.</p></SectionShell>;

  if (member === false) {
    return (
      <SectionShell title="Discussions" description="Topic discussion inside this organization">
        {/* spec 324 §12 — a non-member REQUESTS to join; membership is granted by a steward (enrollment), and
            the presence listing is published as a CONSEQUENCE of that (Complete membership, below). */}
        {/* INVITED: the organization asked them — lead with Join (the same ceremony as the Ask's accept and the Join chip). */}
        {invitedToJoin && (
          <div className="manage-card" style={{ maxWidth: 460, padding: '1.25rem', marginBottom: '0.85rem' }} data-testid="invited-join">
            <h3 className="subhead">You&rsquo;ve been invited to join</h3>
            <p className="manage-card-blurb" style={{ margin: '0 0 0.8rem' }}>
              A steward invited you. Joining signs your membership — your consent, for you alone, revocable anytime.
            </p>
            <button type="button" className="btn-primary" style={{ width: 'auto' }} disabled={busy} onClick={() => void join()}>
              {busy ? 'Joining…' : 'Join'}
            </button>
            {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{error}</p>}
          </div>
        )}
        {!invitedToJoin && (
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
          <ApproveMessaging
        need={wireNeeded}
        person={agentAddress ?? null}
        session={session}
        credential={homeProfile?.credential}
        onApproved={() => noteWireNeeded(null)}
        onError={setError}
      />
      {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{error}</p>}
        </div>
        )}

        {/* After a steward approves, the applicant completes membership here — publishing the listing they sign
            (revocable). recordOrgMembership picks up the org→member grant the approval stored. */}
        {!invitedToJoin && (
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
        )}
      </SectionShell>
    );
  }

  return (
    <SectionShell title="Discussions" description="Topic discussion inside this organization" wide>
      {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{error}</p>}

      {/* SEC-H1 regression fix — a steward can reach channels without a directory listing, so they show
          up as Members · 0 with no way to be seen/messaged. Offer an explicit self-add (publishes the
          steward's own signed listing via the same join() path). Members see the member===false card. */}
      {steward && member && !youAreListed && (
        <div className="chat-attention" style={{ marginBottom: '0.85rem' }}>
          <span style={{ fontSize: '0.85rem' }}>
            <b>Members can&rsquo;t see or message you here yet.</b> Add yourself to this organization&rsquo;s
            directory — it takes one signature.
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
              {busy ? 'Signing…' : 'Add me'}
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
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={orgVault === false} onClick={() => setCreating((v) => !v)} title="New topic">New topic</button>
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
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 5 }}>{c.participationPolicy === 'restricted' && <LockGlyph size={12} style={{ flex: 'none', opacity: 0.7 }} />}<span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span></span>
              <span className="ui-count" style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', background: 'var(--color-surface-sunken)', color: 'var(--color-text-muted)', borderRadius: 999, padding: '1px 7px', fontWeight: 600 }}>{c.messages.length}</span>
            </button>
          ))}
          {channels === null && <div style={{ padding: '0 0.2rem' }}><SkeletonRows rows={4} /></div>}
          {channels && channels.length === 0 && !creating && (
            <EmptyState title="No topics yet" hint="A topic is a place the organization talks about one thing." />
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
                <div style={{ minWidth: 0, flex: 1 }}>
                  <strong># {channel.title}</strong>
                  <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
                    {channel.participationPolicy === 'restricted'
                      ? `Restricted · ${(participants ?? []).length} participants · ${channel.messages.length} messages`
                      : `Open · everyone in the organization participates · ${channel.messages.length} messages`}
                    {channel.assistant && (
                      <span
                        title={`${channel.assistant.displayName} ${channel.assistant.trigger === 'mention' ? `answers @ask (or @${channel.assistant.mentionHandle})` : 'answers every post'}`}
                      >
                        {channel.assistant.trigger === 'mention' ? ' · agent on @ask' : ' · agent auto-replies'}
                      </span>
                    )}
                    {channel.assistant && channel.routing && (
                      <span title={`Member routing on — the assistant may consult up to ${channel.routing.maxFanout} opted-in members' agents per question`}>
                        {' · consults members'}
                      </span>
                    )}
                  </div>
                </div>
                {/* Spec 378 — this topic's huddle: start it here, or join the one already running. Each
                    topic of each team is its own room, judged by standing at this organization. */}
                <span style={{ flex: 'none' }}><HuddleAffordance scope={{ kind: 'topic', principal: org.toLowerCase(), id: channel.descriptor.id }} scopeName={`# ${channel.title}`} /></span>
              </div>

              <div className="chat-thread-body" style={{ flex: 1 }} ref={threadRef} onScroll={onThreadScroll}>
                {channel.messages.length === 0 && <div style={{ margin: 'auto', maxWidth: 420, padding: '2rem 0' }}><EmptyState icon={<HashGlyph size={18} />} title={`Nothing said in # ${channel.title} yet`} hint={channel.assistant?.mentionHandle ? `Say something — @${channel.assistant.mentionHandle} brings the organization's agent in.` : 'Say something to open the conversation.'} /></div>}
                {channel.messages.map((m, idx) => {
                  const l = listingBySubject.get(m.envelope.from.toLowerCase());
                  const mine = m.authorName === you;
                  const prev = channel.messages[idx - 1];
                  const next = channel.messages[idx + 1];
                  const firstOfGroup = !prev || prev.authorName !== m.authorName;
                  const lastOfGroup = !next || next.authorName !== m.authorName;
                  // spec 329 §7 — the routed-consultation contextRef renders as a small chip on the
                  // turn-1 status + turn-2 synthesis posts (member consultation happened here).
                  const routed = (m.envelope.contextRefs ?? []).some((r) => r.kind === 'routed-consultation');

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
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', minWidth: 0 }}>
                        <MessageBubble
                          mine={mine}
                          body={bodies[m.envelope.id]}
                          time={timeShort(m.envelope.createdAt)}
                          authorName={m.authorName}
                          authorBadge={m.actor ? 'assistant' : undefined}
                          showAuthor={!mine}
                          firstOfGroup={firstOfGroup}
                          lastOfGroup={lastOfGroup}
                          onAuthorClick={() => openDm(m.authorName, l?.label, l?.listing.subject)}
                        />
                        {routed && (
                          <span
                            title="This reply involved consulting opted-in members’ agents (routed consultation)"
                            style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)', margin: '0.1rem 0.35rem 0' }}
                          >
                            member consultation
                          </span>
                        )}
                      </div>
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
                rows={3}
                placeholder={orgVault === false
                  ? 'Enable discussion storage to post'
                  : channel.assistant?.trigger === 'mention' && channel.assistant.mentionHandle
                    ? `Message # ${channel.title} — @ask to ask the assistant`
                    : `Message # ${channel.title}`}
              />
            </>
          ) : (
            channels === null
              ? <div style={{ padding: '1rem' }}><SkeletonRows rows={5} lead /></div>
              : <div style={{ margin: 'auto', padding: '2rem', maxWidth: 420 }}><EmptyState icon={<HashGlyph size={18} />} title="Pick a topic" hint="Or create one — a topic is where the organization talks about one thing." /></div>
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
                    <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" title="Invite a participant to this topic" onClick={() => setTopicInviteOpen((v) => !v)}>Invite</button>
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
                          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" title={`Message ${pName}`} onClick={() => openDm(pl.listing.displayName, pl.label, pl.listing.subject)}>
                            <MailIcon size={14} />
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
                      No participants yet{youFacilitator ? ' — use + to invite organization members.' : ''}
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
                          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" style={{ marginLeft: 'auto' }} title="Close" onClick={() => setTopicInviteOpen(false)}>Close</button>
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
                            <a href={`/org/${communityId}/membership`}>Settings &rarr; Membership</a>.
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
          {/* OPEN topic (or no topic selected) → the participant list IS every org member (participation
              is derived from membership; nothing to invite here). Restricted topics render their own
              Participants panel above and do NOT list the whole org. Organization membership management
              (bringing a NEW person in) lives on the dedicated Members page, not in a discussion topic. */}
          {activePolicy !== 'restricted' && (
            <>
              {/* No count: an open topic's participants are "everyone in the organization", and the
                  number of directory LISTINGS is not the number of members — most members here have
                  never published one. A confident 0 beside five join messages is worse than no number. */}
              <div className="channels-sidebar__title"><span>Participants</span></div>
              {channel && (
                <p style={{ fontSize: '0.72rem', opacity: 0.6, padding: '0 0.25rem', margin: '0 0 0.5rem' }}>
                  Open topic — everyone in the organization participates.
                </p>
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
                    <div style={{ fontSize: '0.72rem', opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {l.listing.orgRole ? `${l.listing.orgRole} · ${l.label}` : l.label}
                    </div>
                  </div>
                  {l.listing.displayName !== you && (
                    <span className="channels-member-row__hint" aria-hidden><MailIcon size={13} /></span>
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
            </>
          )}
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
