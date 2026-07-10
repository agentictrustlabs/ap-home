'use client';
// Org channels — Discord/Slack topic boards with Telegram-style member→DM slide-over,
// group avatars, rich messages (emoji + images), amber design system.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { MessageEnvelopeV1 } from '@agenticprimitives/fabric/messaging';
import { useSession } from '../../context/session';
import { SectionShell } from './SectionShell';
import { connectWallet, personalSign } from '../../lib/wallet';
import { passkeySignHash, googleSignHash, type SignHash } from '../../connect-client';
import { issueDirectoryListing } from '../../home/directory';
import { activateVaultIfNeeded, activateInboxDeliveryIfNeeded, isKmsVia, type Via } from '../../home/onboarding';
import { DELIVERY_SERVICE_SA } from '../../lib/inbox-delivery';
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

async function signerFor(via: string, agent: Address, token: string): Promise<SignHash> {
  const v = via.toLowerCase();
  if (v === 'wallet') {
    const addr = await connectWallet();
    return (h) => personalSign(addr, h);
  }
  if (v === 'google') return googleSignHash(agent, token);
  return passkeySignHash;
}

interface ChannelMessage { envelope: MessageEnvelopeV1; authorName: string }
interface Channel { descriptor: { id: string; owner: string }; title: string; createdBy: string; messages: ChannelMessage[] }
interface Listing { listing: { subject: string; displayName: string; communityId: string }; label: string }

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

export function OrgChannelsView({ org }: { org: Address }) {
  const { session, agentAddress } = useSession();
  const communityId = org.toLowerCase();
  const communityAvatar = useAvatar(communityAvatarKey(org));

  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [orgVault, setOrgVault] = useState<boolean | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [you, setYou] = useState<string | null>(null);
  const [member, setMember] = useState<boolean | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joinName, setJoinName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [draft, setDraft] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteQuery, setInviteQuery] = useState('');
  const [inviteHits, setInviteHits] = useState<AgentSearchHit[] | null>(null);
  const [inviteSent, setInviteSent] = useState<string | null>(null);
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
    if (chRes.status === 403) { setMember(false); setChannels(null); return; }
    if (!chRes.ok) { setError(`channels read failed (${chRes.status})`); return; }
    const c = (await chRes.json()) as { channels: Channel[]; bodies?: Record<string, string>; you: string; orgVaultEnabled?: boolean; membership?: string };
    if (c.membership && c.membership !== 'linked') setError(`membership link: ${c.membership}`);
    setMember(true);
    setYou(c.you);
    setChannels(c.channels);
    setBodies(c.bodies ?? {});
    setOrgVault(c.orgVaultEnabled === true);
    setActive((cur) => cur ?? c.channels[0]?.descriptor.id ?? null);
  }, [session, communityId, authed, active]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const join = useCallback(async () => {
    if (!session || !agentAddress || !joinName.trim()) return;
    setBusy(true); setError(null);
    try {
      const sign = await signerFor(session.via, agentAddress as Address, session.token);
      const listing = await issueDirectoryListing(agentAddress as Address, sign, {
        communityId,
        displayName: joinName.trim(),
      });
      const res = await fetch('/connect/directory', {
        method: 'POST', headers: authed,
        body: JSON.stringify({ action: 'publish', listing }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `join failed (${res.status})`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [session, agentAddress, joinName, communityId, authed, load]);

  const createChannel = useCallback(async () => {
    if (!newTitle.trim()) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/connect/channels', {
        method: 'POST', headers: authed,
        body: JSON.stringify({ action: 'create', communityId, title: newTitle.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; channelId?: string; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `create failed (${res.status})`);
      setNewTitle(''); setCreating(false);
      await load();
      if (body.channelId) setActive(body.channelId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [newTitle, communityId, authed, load]);

  const enableOrgVault = useCallback(async () => {
    if (!session || !agentAddress || !DELIVERY_SERVICE_SA) return;
    setBusy(true); setError(null);
    try {
      const via = session.via as Via;
      const auth = isKmsVia(via) ? { token: session.token } : undefined;
      const bound = await activateVaultIfNeeded(org, via, auth);
      if (!bound.ok) throw new Error(bound.error);
      const grant = await activateInboxDeliveryIfNeeded(org, via, auth);
      if (!grant.ok) throw new Error(grant.error);
      setOrgVault(true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [session, agentAddress, org, load]);

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

  const invite = useCallback(async (hit: AgentSearchHit) => {
    setBusy(true); setError(null); setInviteSent(null);
    try {
      const res = await fetch('/connect/inbox', {
        method: 'POST', headers: authed,
        body: JSON.stringify({
          action: 'send',
          toName: hit.name,
          bodyText:
            `You're invited to join this organization's channel discussion. ` +
            `Open the invitation chip on this conversation to join — you'll sign a listing you can revoke anytime.`,
          contextRefs: [{ kind: 'org-channels', id: communityId, label: 'Join the discussion' }],
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `invite failed (${res.status})`);
      setInviteSent(hit.displayName ?? hit.name);
      setInviteQuery(''); setInviteHits(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [authed, communityId]);

  const listingBySubject = useMemo(() => {
    const m = new Map<string, Listing>();
    for (const l of listings) m.set(l.listing.subject.toLowerCase(), l);
    return m;
  }, [listings]);

  const openProfile = (name: string, label?: string, subject?: string) => {
    setProfile({
      name,
      label,
      subject,
      subtitle: label ? 'Member of this organization' : 'Not a current member',
      isYou: name === you,
    });
  };

  const messageFromProfile = (t: ProfileTarget) => {
    setProfile(null);
    if (t.label) {
      setDm({ name: t.name, label: t.label, subject: t.subject });
    }
  };

  const channel = channels?.find((c) => c.descriptor.id === active) ?? null;

  if (!session || !agentAddress) return <SectionShell title="Channels"><p>Not signed in.</p></SectionShell>;

  if (member === false) {
    return (
      <SectionShell title="Channels" description="Topic discussion inside this organization">
        <div className="card" style={{ maxWidth: 460, padding: '1.25rem' }}>
          <h3 style={{ margin: '0 0 0.4rem' }}>Join this organization&rsquo;s channels</h3>
          <p style={{ fontSize: '0.85rem', opacity: 0.75, margin: '0 0 0.8rem' }}>
            Joining publishes a listing you sign — members can see you here and message you directly.
          </p>
          <input
            placeholder="Display name (how members see you)"
            value={joinName}
            onChange={(e) => setJoinName(e.target.value)}
            style={{ width: '100%', marginBottom: '0.6rem' }}
          />
          <button type="button" className="btn" disabled={busy || !joinName.trim()} onClick={() => void join()}>
            {busy ? 'Signing…' : 'Sign & join'}
          </button>
          {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{error}</p>}
        </div>
      </SectionShell>
    );
  }

  return (
    <SectionShell title="Channels" description="Topic discussion inside this organization">
      {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{error}</p>}

      {orgVault === false && (
        <div className="chat-attention" style={{ marginBottom: '0.85rem' }}>
          <span style={{ fontSize: '0.85rem' }}>
            <b>Channel storage isn&rsquo;t enabled yet.</b> A steward authorizes the org vault once — then channels + posts are encrypted under the org&rsquo;s authority.
          </span>
          <button type="button" className="btn" disabled={busy} onClick={() => void enableOrgVault()} style={{ marginTop: '0.5rem' }}>
            {busy ? 'Signing…' : 'Enable (steward)'}
          </button>
        </div>
      )}

      <div className="channels-layout">
        <div className="channels-sidebar">
          <div className="channels-sidebar__title">
            <span>Channels</span>
            <button type="button" className="btn" style={{ padding: '0.1rem 0.5rem' }} disabled={orgVault === false} onClick={() => setCreating((v) => !v)} title="New channel">＋</button>
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
              <button type="button" className="btn" disabled={busy || !newTitle.trim()} onClick={() => void createChannel()}>Create</button>
            </div>
          )}
          {(channels ?? []).map((c) => (
            <button
              key={c.descriptor.id}
              type="button"
              className={`channels-sidebar__item${c.descriptor.id === active ? ' channels-sidebar__item--active' : ''}`}
              onClick={() => setActive(c.descriptor.id)}
            >
              <span># {c.title}</span>
              <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>{c.messages.length}</span>
            </button>
          ))}
          {channels && channels.length === 0 && !creating && (
            <p style={{ fontSize: '0.8rem', opacity: 0.6, padding: '0 0.4rem' }}>No channels yet.</p>
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
                    {listings.length} members · {channel.messages.length} messages
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
                            style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer' }}
                            onClick={() => openProfile(m.authorName, l?.label, l?.listing.subject)}
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
                        onAuthorClick={() => openProfile(m.authorName, l?.label, l?.listing.subject)}
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
                placeholder={orgVault === false ? 'Enable channel storage to post' : `Message # ${channel.title}`}
              />
            </>
          ) : (
            <p style={{ opacity: 0.6, margin: 'auto', padding: '2rem' }}>{channels === null ? 'Loading…' : 'Pick or create a channel.'}</p>
          )}
        </div>

        <div className="channels-members">
          <div className="channels-sidebar__title">
            <span>Members · {listings.length}</span>
            <button type="button" className="btn" style={{ padding: '0.1rem 0.5rem' }} onClick={() => setInviteOpen((v) => !v)} title="Invite">＋</button>
          </div>
          {inviteOpen && (
            <div style={{ margin: '0.25rem 0 0.5rem', padding: '0 0.25rem' }}>
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
                  <button type="button" className="btn" style={{ padding: '0 0.4rem', fontSize: '0.72rem' }} disabled={busy} onClick={() => void invite(h)}>Invite</button>
                </div>
              ))}
              {inviteSent && <p style={{ fontSize: '0.75rem', color: 'var(--color-sage-700)' }}>Invitation sent to {inviteSent}.</p>}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
            {listings.map((l) => (
              <button
                key={l.listing.subject}
                type="button"
                className="channels-member-row"
                onClick={() => openProfile(l.listing.displayName, l.label, l.listing.subject)}
              >
                <MemberAvatar listing={l} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '0.83rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.listing.displayName}{l.listing.displayName === you ? ' (you)' : ''}
                  </div>
                  <div style={{ fontSize: '0.72rem', opacity: 0.55 }}>{l.label}</div>
                </div>
              </button>
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
          onClose={() => setDm(null)}
        />
      )}
    </SectionShell>
  );
}
