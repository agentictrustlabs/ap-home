'use client';
// Org channels (spec 318 demo realization / spec 313 §3) — the Slack/Discord/Telegram-shaped surface
// for TOPIC discussion inside ONE organization. The org's channels namespace is `communityId = the org
// SA address`; membership is the spec-312 consent model (ADR-0025): you appear and may read/post ONLY
// because you published a self-signed, revocable directory listing into the org's community — joining
// the org's channels and being discoverable to the org are the same opt-in.
//
// Three columns, the familiar model:
//   channels rail (create/join a topic) | topic feed + composer | members rail (who's here)
// Every poster/member resolves to their agent NAME, and "Message" deep-links to the person's own
// /messages composer (`?to=<label>`) — a channel post is a board fact; a DM is ordinary 1:1 mail on
// the same substrate (spec 312), never a second messaging mechanism.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Address } from '@agenticprimitives/types';
import type { MessageEnvelopeV1 } from '@agenticprimitives/fabric/messaging';
import { useSession } from '../../context/session';
import { SectionShell } from './SectionShell';
import { connectWallet, personalSign } from '../../lib/wallet';
import { passkeySignHash, googleSignHash, type SignHash } from '../../connect-client';
import { issueDirectoryListing } from '../../home/directory';
import { issueInboxDeliveryDelegation, toWire } from '../../lib/delegation';
import { DELIVERY_SERVICE_SA, MCP_SERVER_ID } from '../../lib/inbox-delivery';
import { searchAgentsKb, type AgentSearchHit } from '../../lib/agent-search';

async function signerFor(via: string, agent: Address, token: string): Promise<SignHash> {
  const v = via.toLowerCase();
  if (v === 'wallet') {
    const addr = await connectWallet();
    return (h) => personalSign(addr, h);
  }
  if (v === 'google') return googleSignHash(agent, token);
  return passkeySignHash;
}

// Server shapes (server/connect/channels.ts + directory.ts) — mirrored, not imported (server module
// pulls server-only deps).
interface ChannelMessage { envelope: MessageEnvelopeV1; authorName: string }
interface Channel { descriptor: { id: string; owner: string }; title: string; createdBy: string; messages: ChannelMessage[] }
interface Listing { listing: { subject: string; displayName: string; communityId: string }; label: string }

const timeShort = (iso: string): string => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/** Deterministic avatar hue per author name — the familiar chat-app identity cue. */
const hueOf = (s: string): number => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: 30, height: 30, borderRadius: 8, flex: 'none', display: 'inline-flex', alignItems: 'center',
        justifyContent: 'center', fontSize: '0.8rem', fontWeight: 700, color: '#fff',
        background: `hsl(${hueOf(name)} 55% 45%)`,
      }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function OrgChannelsView({ org }: { org: Address }) {
  const router = useRouter();
  const { session, agentAddress } = useSession();
  const communityId = org.toLowerCase();

  const [channels, setChannels] = useState<Channel[] | null>(null);
  // Post bodies of the ACTIVE channel, resolved server-side from the ORG's vault (spec 318 residency).
  const [bodies, setBodies] = useState<Record<string, string>>({});
  // Has a steward signed the org's standing delivery grant? false ⇒ posting is blocked (fail-closed).
  const [orgVault, setOrgVault] = useState<boolean | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [you, setYou] = useState<string | null>(null);
  const [member, setMember] = useState<boolean | null>(null); // null = loading
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Join form
  const [joinName, setJoinName] = useState('');
  // Create-channel form
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  // Composer
  const [draft, setDraft] = useState('');
  // Invite (spec 318 §invite): find a Person in the KB (naming/knowledge-graph search, spec 314) and
  // send them an ordinary inbox message carrying an `org-channels` context ref — the chip in THEIR
  // /messages routes them to this join gate. The invite never enrolls anyone (ADR-0025): the invitee
  // still signs their own listing to appear here.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteQuery, setInviteQuery] = useState('');
  const [inviteHits, setInviteHits] = useState<AgentSearchHit[] | null>(null);
  const [inviteSent, setInviteSent] = useState<string | null>(null);

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
    const c = (await chRes.json()) as { channels: Channel[]; bodies?: Record<string, string>; you: string; orgVaultEnabled?: boolean };
    setMember(true);
    setYou(c.you);
    setChannels(c.channels);
    setBodies(c.bodies ?? {});
    setOrgVault(c.orgVaultEnabled === true);
    setActive((cur) => cur ?? c.channels[0]?.descriptor.id ?? null);
  }, [session, communityId, authed, active]);

  useEffect(() => { void load(); }, [load]);
  // Board polling — same cadence as the inbox (spec 313).
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

  // Steward action (spec 318): sign the ORG's standing delivery grant (delegator = the org SA — the
  // steward's credential signs; demo-mcp ERC-1271-verifies it against the org account at redemption)
  // and store it under owner = the org. Until this exists, posting fails closed.
  const enableOrgVault = useCallback(async () => {
    if (!session || !agentAddress || !DELIVERY_SERVICE_SA) return;
    setBusy(true); setError(null);
    try {
      const sign = await signerFor(session.via, agentAddress as Address, session.token);
      const delegation = await issueInboxDeliveryDelegation(org, DELIVERY_SERVICE_SA, MCP_SERVER_ID, sign);
      const res = await fetch('/connect/inbox/delivery-grant', {
        method: 'POST', headers: authed,
        body: JSON.stringify({ owner: org, delegation: toWire(delegation) }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok !== true) throw new Error(data.error ?? `org vault enable failed (${res.status})`);
      setOrgVault(true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [session, agentAddress, org, authed, load]);

  const post = useCallback(async () => {
    if (!active || !draft.trim()) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/connect/channels', {
        method: 'POST', headers: authed,
        body: JSON.stringify({ action: 'post', communityId, channelId: active, bodyText: draft.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `post failed (${res.status})`);
      setDraft('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [active, draft, communityId, authed, load]);

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

  // Poster → member listing (CAIP subject match) so any author with a current listing gets a DM link.
  const listingBySubject = useMemo(() => {
    const m = new Map<string, Listing>();
    for (const l of listings) m.set(l.listing.subject.toLowerCase(), l);
    return m;
  }, [listings]);

  const dmHref = (label: string): string => `/messages?to=${encodeURIComponent(label)}`;

  const channel = channels?.find((c) => c.descriptor.id === active) ?? null;
  const posters = useMemo(() => {
    if (!channel) return [];
    const seen = new Map<string, { name: string; label?: string }>();
    for (const m of channel.messages) {
      const l = listingBySubject.get(m.envelope.from.toLowerCase());
      seen.set(m.authorName, { name: m.authorName, label: l?.label });
    }
    return [...seen.values()];
  }, [channel, listingBySubject]);

  if (!session || !agentAddress) return <SectionShell title="Channels"><p>Not signed in.</p></SectionShell>;

  // ── Join gate (opt-in consent, ADR-0025) ──────────────────────────────────────────────────────
  if (member === false) {
    return (
      <SectionShell title="Channels" description="Topic discussion inside this organization">
        <div className="card" style={{ maxWidth: 460, padding: '1.25rem' }}>
          <h3 style={{ margin: '0 0 0.4rem' }}>Join this organization&rsquo;s channels</h3>
          <p style={{ fontSize: '0.85rem', opacity: 0.75, margin: '0 0 0.8rem' }}>
            Joining publishes a listing you sign — people in this organization can then see you here and
            message you directly. You can leave (revoke it) anytime.
          </p>
          <input
            placeholder="Display name (how members see you)"
            value={joinName}
            onChange={(e) => setJoinName(e.target.value)}
            style={{ width: '100%', marginBottom: '0.6rem' }}
          />
          <button className="btn" disabled={busy || !joinName.trim()} onClick={() => void join()}>
            {busy ? 'Signing…' : 'Sign & join'}
          </button>
          {error && <p style={{ color: '#b91c1c', fontSize: '0.8rem' }}>{error}</p>}
        </div>
      </SectionShell>
    );
  }

  return (
    <SectionShell title="Channels" description="Topic discussion inside this organization">
      {error && <p style={{ color: '#b91c1c', fontSize: '0.8rem' }}>{error}</p>}
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'stretch', minHeight: 480 }}>
        {/* ── Channels rail ── */}
        <div style={{ width: 210, flex: 'none', borderRight: '1px solid #e5e7eb', paddingRight: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <strong style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.6 }}>Channels</strong>
            <button className="btn" style={{ padding: '0.1rem 0.5rem' }} onClick={() => setCreating((v) => !v)} title="New channel">＋</button>
          </div>
          {creating && (
            <div style={{ marginBottom: '0.6rem' }}>
              <input
                placeholder="Topic, e.g. fundraising"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void createChannel(); }}
                style={{ width: '100%', marginBottom: '0.3rem' }}
              />
              <button className="btn" disabled={busy || !newTitle.trim()} onClick={() => void createChannel()}>Create</button>
            </div>
          )}
          {(channels ?? []).map((c) => (
            <button
              key={c.descriptor.id}
              onClick={() => setActive(c.descriptor.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                borderRadius: 8, padding: '0.4rem 0.55rem', marginBottom: 2, fontSize: '0.9rem',
                background: c.descriptor.id === active ? '#eef2ff' : 'transparent',
                color: c.descriptor.id === active ? '#4338ca' : 'inherit',
                fontWeight: c.descriptor.id === active ? 600 : 400,
              }}
            >
              # {c.title}
              <span style={{ float: 'right', opacity: 0.5, fontSize: '0.75rem' }}>{c.messages.length}</span>
            </button>
          ))}
          {channels && channels.length === 0 && !creating && (
            <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>No channels yet — create the first topic.</p>
          )}
        </div>

        {/* ── Topic feed + composer ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {channel ? (
            <>
              <div style={{ borderBottom: '1px solid #e5e7eb', paddingBottom: '0.5rem', marginBottom: '0.5rem' }}>
                <strong># {channel.title}</strong>
                <span style={{ marginLeft: '0.75rem', fontSize: '0.78rem', opacity: 0.6 }}>
                  {posters.length > 0 ? `posted by ${posters.map((p) => p.name).join(', ')}` : 'no posts yet'}
                </span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                {channel.messages.map((m) => {
                  const l = listingBySubject.get(m.envelope.from.toLowerCase());
                  const mine = m.authorName === you;
                  return (
                    <div key={m.envelope.id} style={{ display: 'flex', gap: '0.55rem', alignItems: 'flex-start' }}>
                      <Avatar name={m.authorName} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: '0.8rem', marginBottom: 1 }}>
                          <strong>{m.authorName}</strong>
                          {l && <span style={{ opacity: 0.55 }}> · {l.label}</span>}
                          <span style={{ opacity: 0.45, marginLeft: '0.5rem' }}>{timeShort(m.envelope.createdAt)}</span>
                          {!mine && l && (
                            <button
                              className="btn"
                              style={{ marginLeft: '0.6rem', padding: '0 0.45rem', fontSize: '0.72rem' }}
                              onClick={() => router.push(dmHref(l.label))}
                              title={`Direct-message ${m.authorName}`}
                            >
                              Message
                            </button>
                          )}
                        </div>
                        <div style={{ fontSize: '0.92rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', opacity: bodies[m.envelope.id] ? 1 : 0.45 }}>
                          {bodies[m.envelope.id] ?? '[content unavailable — stored before vault cutover or not yet decrypted]'}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {channel.messages.length === 0 && (
                  <p style={{ fontSize: '0.85rem', opacity: 0.6 }}>Start the discussion in <b># {channel.title}</b>.</p>
                )}
              </div>
              {orgVault === false && (
                <div style={{ border: '1px solid #fcd34d', background: '#fffbeb', color: '#92400e', borderRadius: 8, padding: '0.5rem 0.8rem', marginTop: '0.6rem', fontSize: '0.82rem', display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span>
                    <b>Channel storage isn&rsquo;t enabled yet.</b> A steward signs one authorization so posts are
                    stored encrypted in the organization&rsquo;s vault.
                  </span>
                  <button className="btn" disabled={busy} onClick={() => void enableOrgVault()}>
                    {busy ? 'Signing…' : 'Enable (steward)'}
                  </button>
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
                <input
                  disabled={orgVault === false}
                  placeholder={`Message # ${channel.title}`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) void post(); }}
                  style={{ flex: 1 }}
                />
                <button className="btn" disabled={busy || !draft.trim()} onClick={() => void post()}>
                  {busy ? '…' : 'Send'}
                </button>
              </div>
            </>
          ) : (
            <p style={{ opacity: 0.6, margin: 'auto' }}>{channels === null ? 'Loading…' : 'Pick or create a channel.'}</p>
          )}
        </div>

        {/* ── Members rail ── */}
        <div style={{ width: 200, flex: 'none', borderLeft: '1px solid #e5e7eb', paddingLeft: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.6 }}>
              Members · {listings.length}
            </strong>
            <button className="btn" style={{ padding: '0.1rem 0.5rem' }} onClick={() => setInviteOpen((v) => !v)} title="Invite a person">
              ＋
            </button>
          </div>
          {inviteOpen && (
            <div style={{ margin: '0.5rem 0 0.25rem' }}>
              <input
                placeholder="Find a person by name…"
                value={inviteQuery}
                onChange={(e) => setInviteQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void searchInvitees(); }}
                style={{ width: '100%', marginBottom: '0.3rem' }}
              />
              {inviteHits?.map((h) => (
                <div key={h.name} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: 2 }}>
                  <div style={{ minWidth: 0, flex: 1, fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <b>{h.displayName ?? h.label}</b> <span style={{ opacity: 0.55 }}>{h.name}</span>
                  </div>
                  <button className="btn" style={{ padding: '0 0.4rem', fontSize: '0.72rem' }} disabled={busy} onClick={() => void invite(h)}>
                    Invite
                  </button>
                </div>
              ))}
              {inviteHits && inviteHits.length === 0 && <p style={{ fontSize: '0.75rem', opacity: 0.6 }}>No one found.</p>}
              {inviteSent && <p style={{ fontSize: '0.75rem', color: '#047857' }}>Invitation sent to {inviteSent}.</p>}
            </div>
          )}
          <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
            {listings.map((l) => (
              <div key={l.listing.subject} style={{ display: 'flex', gap: '0.45rem', alignItems: 'center' }}>
                <Avatar name={l.listing.displayName} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '0.83rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.listing.displayName}{l.listing.displayName === you ? ' (you)' : ''}
                  </div>
                  <div style={{ fontSize: '0.72rem', opacity: 0.55 }}>{l.label}</div>
                </div>
                {l.listing.displayName !== you && (
                  <button
                    className="btn"
                    style={{ padding: '0 0.4rem', fontSize: '0.72rem' }}
                    onClick={() => router.push(dmHref(l.label))}
                    title={`Direct-message ${l.listing.displayName}`}
                  >
                    ✉
                  </button>
                )}
              </div>
            ))}
            {listings.length === 0 && <p style={{ fontSize: '0.78rem', opacity: 0.6 }}>No one has joined yet.</p>}
          </div>
        </div>
      </div>
    </SectionShell>
  );
}
