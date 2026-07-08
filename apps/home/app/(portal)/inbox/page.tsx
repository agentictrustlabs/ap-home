'use client';
// The agentic inbox — synthesis surface (spec 312 §7, docs/architecture/
// inbox-ux-synthesis.md): Outlook's triage band + deterministic folders,
// Slack's conversation-first list + context chips, Signal's signature cues,
// Diode's vault-residency posture. Approve/Deny buttons feed the interactions
// state machine through the audited store; they grant nothing — issuance
// routes through the authority packages.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type {
  ContextRefV1,
  ConversationDescriptorV1,
  ConversationSummaryV1,
  FolderSummaryV1,
  InboxItemV1,
  MessageEnvelopeV1,
} from '@agenticprimitives/messaging';
import { generateMessageId, generateConversationId, sha256Hex32 } from '@agenticprimitives/messaging';
import type { ActionCardV1, InteractionCaseV1, InteractionMandateV1 } from '@agenticprimitives/interactions';
import { generateInteractionId } from '@agenticprimitives/interactions';
import type { HomeInboxSummaryV1 } from '@agenticprimitives/home';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { connectWallet, personalSign } from '../../../src/lib/wallet';
import { passkeySignHash, googleSignHash, type SignHash } from '../../../src/connect-client';
import { nameLabel } from '../../../src/lib/domain';
import { homeCaip10 } from '../../../src/home/manifest';
import { issueMandateForCase } from '../../../src/home/mandate';

async function signerFor(via: string, agent: Address, token: string): Promise<SignHash> {
  const v = via.toLowerCase();
  if (v === 'wallet') {
    const addr = await connectWallet();
    return (h) => personalSign(addr, h);
  }
  if (v === 'google') return googleSignHash(agent, token);
  return passkeySignHash;
}

interface EnvelopeMeta {
  from: string;
  subject?: string;
  contextRefs?: ContextRefV1[];
  signatureSigner?: string;
  createdAt: string;
}

interface InboxView {
  items: InboxItemV1[];
  folders: FolderSummaryV1[];
  summary: HomeInboxSummaryV1;
  cases: InteractionCaseV1[];
  cards: Record<string, ActionCardV1>;
  bodies: Record<string, string>;
  mandates: Record<string, InteractionMandateV1>;
  conversations: ConversationSummaryV1[];
  descriptors: Record<string, ConversationDescriptorV1>;
  envelopeMeta: Record<string, EnvelopeMeta>;
}

const PENDING_STATES = ['delivered', 'seen', 'triaged'];

const short = (caip: string): string => {
  const addr = caip.match(/0x[0-9a-fA-F]{40}$/)?.[0];
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : caip.slice(0, 18);
};

function ContextChip({ r, active, onClick }: { r: { kind: string; id: string; label?: string }; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: '1px solid #c7d2fe',
        background: active ? '#4338ca' : '#eef2ff',
        color: active ? '#fff' : '#4338ca',
        borderRadius: 999,
        padding: '0.1rem 0.6rem',
        fontSize: '0.72rem',
        cursor: onClick ? 'pointer' : 'default',
      }}
      title={`${r.kind}: ${r.id}`}
    >
      {r.label ?? `${r.kind}:${short(r.id)}`}
    </button>
  );
}

function SignatureChip({ meta }: { meta?: EnvelopeMeta }) {
  if (!meta) return null;
  return meta.signatureSigner ? (
    <span style={{ fontSize: '0.72rem', color: '#15803d' }} title={meta.signatureSigner}>
      ✓ signed by {short(meta.signatureSigner)}
    </span>
  ) : (
    <span style={{ fontSize: '0.72rem', color: '#92400e' }}>⚠ no signature</span>
  );
}

export default function InboxPage() {
  const { session, agentAddress, agentName } = useSession();
  const [view, setView] = useState<InboxView | null>(null);
  const [folder, setFolder] = useState<string>('all');
  const [context, setContext] = useState<{ kind: string; id: string; label?: string } | null>(null);
  const [openConv, setOpenConv] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState({ toLabel: '', subject: '', bodyText: '' });
  const [dirCommunity, setDirCommunity] = useState('');
  const [dirListings, setDirListings] = useState<{ label: string; displayName: string }[] | null>(null);

  const refresh = useCallback(async () => {
    if (!session) return;
    const res = await fetch('/connect/inbox', { headers: { authorization: `Bearer ${session.token}` } });
    if (res.ok) setView((await res.json()) as InboxView);
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const post = useCallback(
    async (body: Record<string, unknown>, key: string) => {
      if (!session) return false;
      setBusy(key);
      setError(null);
      try {
        const res = await fetch('/connect/inbox', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
          body: JSON.stringify(body),
        });
        const out = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !out.ok) throw new Error(out.error ?? `failed (${res.status})`);
        await refresh();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [session, refresh],
  );

  // Demo helper: deliver a signed-shape access request to YOURSELF through the
  // full public delivery pipeline (on-chain label check + audited admission).
  const sendDemoRequest = useCallback(async () => {
    if (!session || !agentAddress) return;
    if (!agentName) {
      setError('Your agent needs a claimed name first — delivery verifies your name resolves to your agent on-chain. Claim a name, then retry.');
      return;
    }
    setBusy('demo');
    setError(null);
    try {
      const me = homeCaip10(agentAddress as Address);
      const label = nameLabel(agentName);
      const bodyText = 'Demo: an agent asks to read your contact email for delivery updates (purpose: notifications).';
      const now = new Date().toISOString();
      const interactionId = generateInteractionId();
      const contextRefs: ContextRefV1[] = [{ kind: 'resource', id: 'contact-email', label: 'Contact email' }];
      const envelope: MessageEnvelopeV1 = {
        version: 'ap.message.v1',
        id: generateMessageId(),
        conversationId: generateConversationId(),
        kind: 'request',
        from: me,
        to: [me],
        subject: 'Access request: contact email',
        createdAt: now,
        classification: 'internal',
        body: { resource: 'inline:demo', classification: 'internal', updatedAt: now },
        bodyHash: await sha256Hex32(new TextEncoder().encode(bodyText)),
        bodyContentType: 'text/plain',
        interactionId,
        contextRefs,
        priority: 'high',
      };
      const interactionCase: InteractionCaseV1 = {
        version: 'ap.interaction.v1',
        id: interactionId,
        kind: 'access-request',
        subject: 'Read contact email (purpose: notifications)',
        contextRefs,
        requester: me,
        responder: me,
        state: 'draft',
        createdAt: now,
        updatedAt: now,
        rootMessageId: envelope.id,
        latestMessageId: envelope.id,
        evidenceRefs: [],
        authorityRefs: [],
      };
      const card: ActionCardV1 = {
        version: 'ap.interaction.action-card.v1',
        cardId: `card_${interactionId.slice(4)}`,
        interactionId,
        cardKind: 'access-request',
        title: 'Share your contact email?',
        summary: 'Requested for delivery notifications. You can ask for more information first.',
        allowedActions: [
          { actionId: 'approve', label: 'Approve', transition: 'approve', style: 'primary' },
          { actionId: 'deny', label: 'Deny', transition: 'deny', style: 'destructive' },
          { actionId: 'ask', label: 'Ask for info', transition: 'ask-info' },
        ],
      };
      const res = await fetch('/connect/inbox/deliver', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, envelope, bodyText, interactionCase, card }),
      });
      const out = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !out.ok) throw new Error(out.error ?? `delivery failed (${res.status})`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [session, agentAddress, agentName, refresh]);

  // W5: approving an access-request ISSUES — the person signs a scoped
  // delegation (the authority) + the mandate that references it, both under
  // their ROOT credential; the server ERC-1271-verifies before committing.
  const approveWithMandate = useCallback(
    async (c: InteractionCaseV1) => {
      if (!session || !agentAddress) return;
      setBusy(c.id);
      setError(null);
      try {
        const sign = await signerFor(session.via, agentAddress as Address, session.token);
        const { mandate } = await issueMandateForCase(c, agentAddress as Address, sign);
        const res = await fetch('/connect/inbox', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
          body: JSON.stringify({ action: 'transition', transition: 'approve', interactionId: c.id, mandate }),
        });
        const out = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !out.ok) throw new Error(out.error ?? `failed (${res.status})`);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [session, agentAddress, refresh],
  );

  // Directory picker (spec 312 W3): only OPT-IN listings, community-scoped —
  // there is no roster to browse without one (ADR-0025).
  const browseDirectory = useCallback(async () => {
    if (!session || !dirCommunity.trim()) return;
    setError(null);
    try {
      const res = await fetch(`/connect/directory?communityId=${encodeURIComponent(dirCommunity.trim().toLowerCase())}`, {
        headers: { authorization: `Bearer ${session.token}` },
      });
      const out = (await res.json()) as { listings?: { label: string; listing: { displayName: string } }[]; error?: string };
      if (!res.ok) throw new Error(out.error ?? `lookup failed (${res.status})`);
      setDirListings((out.listings ?? []).map((l) => ({ label: l.label, displayName: l.listing.displayName })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [session, dirCommunity]);

  const sendCompose = useCallback(async () => {
    const ok = await post(
      { action: 'send', toLabel: compose.toLabel, subject: compose.subject || undefined, bodyText: compose.bodyText },
      'compose',
    );
    if (ok) {
      setCompose({ toLabel: '', subject: '', bodyText: '' });
      setComposeOpen(false);
    }
  }, [post, compose]);

  const pendingCases = useMemo(
    () => (view?.cases ?? []).filter((c) => PENDING_STATES.includes(c.state)),
    [view],
  );
  const urgentUnread = useMemo(
    () => (view?.items ?? []).filter((i) => i.unread && (i.priority === 'urgent' || i.priority === 'high') && i.folder !== 'trash'),
    [view],
  );

  const itemsByConv = useMemo(() => {
    const map = new Map<string, InboxItemV1[]>();
    for (const i of view?.items ?? []) {
      if (i.folder === 'trash') continue;
      map.set(i.conversationId, [...(map.get(i.conversationId) ?? []), i]);
    }
    return map;
  }, [view]);

  const conversations = useMemo(() => {
    let rows = view?.conversations ?? [];
    if (context) rows = rows.filter((c) => c.contextRefs.some((r) => r.kind === context.kind && r.id === context.id));
    if (folder !== 'all') {
      rows = rows.filter((c) => (itemsByConv.get(c.conversationId) ?? []).some((i) => i.folder === folder));
    }
    return rows;
  }, [view, context, folder, itemsByConv]);

  if (!session) {
    return (
      <SectionShell title="Inbox" description="Sign in to see your agentic inbox.">
        <p>Not signed in.</p>
      </SectionShell>
    );
  }

  return (
    <SectionShell
      title="Inbox"
      description="Conversations, requests, and everything acting in your name. Approving records a decision — authority is issued separately, on your terms. Bodies stay in your vault; deliveries are audited before they land."
    >
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}

      {/* ── Needs attention (Outlook focused-triage band) ── */}
      {(pendingCases.length > 0 || urgentUnread.length > 0) && (
        <div className="dash-section" style={{ border: '1px solid #fcd34d', background: '#fffbeb', borderRadius: 8, padding: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>
            Needs attention · {pendingCases.length} pending{urgentUnread.length > 0 ? ` · ${urgentUnread.length} urgent` : ''}
          </h2>
          {pendingCases.map((c) => {
            const card = view?.cards[c.id];
            const actions = card?.allowedActions ?? [
              { actionId: 'approve', label: 'Approve', transition: 'approve' as const, style: 'primary' as const },
              { actionId: 'deny', label: 'Deny', transition: 'deny' as const, style: 'destructive' as const },
            ];
            return (
              <div key={c.id} style={{ marginBottom: '0.75rem', padding: '1rem', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                  <div>
                    <b>{card?.title ?? c.subject}</b>
                    <div style={{ fontSize: '0.85rem', opacity: 0.75 }}>
                      {card?.summary ?? `${c.kind} · from ${short(c.requester)} · state: ${c.state}`}
                    </div>
                    {(c.contextRefs ?? []).length > 0 && (
                      <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.35rem', flexWrap: 'wrap' }}>
                        {(c.contextRefs ?? []).map((r) => (
                          <ContextChip key={`${r.kind}:${r.id}`} r={r} onClick={() => setContext(r)} />
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    {actions.map((a) => {
                      const issues = a.transition === 'approve' && c.kind === 'access-request';
                      return (
                        <button
                          key={a.actionId}
                          className="btn"
                          style={a.style === 'destructive' ? { background: '#fee2e2', color: '#b91c1c' } : undefined}
                          disabled={busy !== null}
                          title={issues ? 'Signs a scoped delegation + mandate (two prompts)' : undefined}
                          onClick={() =>
                            issues
                              ? void approveWithMandate(c)
                              : void post({ action: 'transition', interactionId: c.id, transition: a.transition }, c.id)
                          }
                        >
                          {busy === c.id ? '…' : issues ? `${a.label} + issue mandate` : a.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="dash-section" style={{ marginTop: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
          <h2>Conversations{view?.summary ? ` · ${view.summary.unreadTotal} unread` : ''}</h2>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn" onClick={() => setComposeOpen((v) => !v)} disabled={busy !== null}>
              {composeOpen ? 'Close composer' : 'New message'}
            </button>
            <button className="btn" onClick={() => void sendDemoRequest()} disabled={busy !== null}>
              {busy === 'demo' ? 'Delivering…' : 'Send yourself a demo request'}
            </button>
          </div>
        </div>

        {/* ── Composer (directory picker lands in W3; name-addressed today) ── */}
        {composeOpen && (
          <div style={{ margin: '0.75rem 0', padding: '1rem', border: '1px solid #e5e7eb', borderRadius: 8, display: 'grid', gap: '0.5rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                placeholder="Find people: community id (opt-in listings only)"
                value={dirCommunity}
                onChange={(e) => setDirCommunity(e.target.value)}
                style={{ padding: '0.4rem 0.6rem', border: '1px solid #d1d5db', borderRadius: 6, flex: 1, minWidth: 220 }}
              />
              <button className="btn" disabled={!dirCommunity.trim()} onClick={() => void browseDirectory()}>
                Browse directory
              </button>
            </div>
            {dirListings !== null && (
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                {dirListings.length === 0 ? (
                  <span style={{ fontSize: '0.8rem', opacity: 0.65 }}>
                    No one has opted in to this community&apos;s directory yet.
                  </span>
                ) : (
                  dirListings.map((l) => (
                    <button
                      key={l.label}
                      className="btn"
                      style={{ fontSize: '0.78rem' }}
                      onClick={() => setCompose((c) => ({ ...c, toLabel: l.label }))}
                    >
                      {l.displayName} ({l.label})
                    </button>
                  ))
                )}
              </div>
            )}
            <input
              placeholder="To (their claimed name, e.g. sarah)"
              value={compose.toLabel}
              onChange={(e) => setCompose((c) => ({ ...c, toLabel: e.target.value }))}
              style={{ padding: '0.4rem 0.6rem', border: '1px solid #d1d5db', borderRadius: 6 }}
            />
            <input
              placeholder="Subject (optional)"
              value={compose.subject}
              onChange={(e) => setCompose((c) => ({ ...c, subject: e.target.value }))}
              style={{ padding: '0.4rem 0.6rem', border: '1px solid #d1d5db', borderRadius: 6 }}
            />
            <textarea
              placeholder="Message — stays in the recipient's vault, delivered through audited admission."
              value={compose.bodyText}
              onChange={(e) => setCompose((c) => ({ ...c, bodyText: e.target.value }))}
              rows={4}
              style={{ padding: '0.4rem 0.6rem', border: '1px solid #d1d5db', borderRadius: 6 }}
            />
            <div>
              <button className="btn" disabled={busy !== null || !compose.toLabel.trim() || !compose.bodyText.trim()} onClick={() => void sendCompose()}>
                {busy === 'compose' ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        )}

        {/* ── Filter row: folders + active context chip ── */}
        <div style={{ display: 'flex', gap: '0.5rem', margin: '0.75rem 0', flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn" style={folder === 'all' ? { fontWeight: 700 } : undefined} onClick={() => setFolder('all')}>
            All
          </button>
          {(view?.folders ?? []).map((f) => (
            <button key={f.folder} className="btn" style={folder === f.folder ? { fontWeight: 700 } : undefined} onClick={() => setFolder(f.folder)}>
              {f.folder} ({f.unread}/{f.total})
            </button>
          ))}
          {context && (
            <span style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center' }}>
              <ContextChip r={context} active />
              <button className="btn" onClick={() => setContext(null)} style={{ fontSize: '0.72rem' }}>
                clear filter
              </button>
            </span>
          )}
        </div>

        {/* ── Conversation-first list (Slack) ── */}
        {conversations.length === 0 ? (
          <p style={{ opacity: 0.7 }}>
            Nothing here yet. Start one with New message, or deliveries land via <code>/connect/inbox/deliver</code>.
          </p>
        ) : (
          conversations.map((conv) => {
            const descriptor = view?.descriptors[conv.conversationId];
            const convItems = (itemsByConv.get(conv.conversationId) ?? []).filter(
              (i) => folder === 'all' || i.folder === folder,
            );
            const isOpen = openConv === conv.conversationId;
            const newest = convItems[0];
            const newestMeta = newest ? view?.envelopeMeta[newest.messageId] : undefined;
            return (
              <div key={conv.conversationId} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <div
                  style={{ padding: '0.75rem 0', display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', cursor: 'pointer' }}
                  onClick={() => setOpenConv(isOpen ? null : conv.conversationId)}
                >
                  <div>
                    <span style={{ fontWeight: conv.unread > 0 ? 700 : 400 }}>
                      {conv.unread > 0 && <span style={{ color: '#4338ca' }}>● </span>}
                      {descriptor?.title ?? newestMeta?.subject ?? `Conversation with ${newestMeta ? short(newestMeta.from) : '…'}`}
                    </span>
                    <span style={{ fontSize: '0.8rem', opacity: 0.65 }}>
                      {' '}· {conv.messageCount} message{conv.messageCount === 1 ? '' : 's'}
                      {conv.unread > 0 ? ` · ${conv.unread} unread` : ''}
                      {conv.hasPending ? ' · pending review' : ''}
                    </span>
                    <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.35rem', flexWrap: 'wrap' }}>
                      {conv.contextRefs.map((r) => (
                        <ContextChip
                          key={`${r.kind}:${r.id}`}
                          r={r}
                          active={context?.kind === r.kind && context.id === r.id}
                          onClick={() => setContext(context?.kind === r.kind && context.id === r.id ? null : r)}
                        />
                      ))}
                    </div>
                  </div>
                  <div style={{ fontSize: '0.8rem', opacity: 0.65 }}>{new Date(conv.lastEventAt).toLocaleString()}</div>
                </div>

                {/* ── Conversation view: messages + signature chips (Signal) ── */}
                {isOpen && (
                  <div style={{ padding: '0 0 0.75rem 1rem', display: 'grid', gap: '0.5rem' }}>
                    {[...convItems].reverse().map((i) => {
                      const meta = view?.envelopeMeta[i.messageId];
                      const body = view?.bodies[i.messageId];
                      return (
                        <div key={i.messageId} style={{ padding: '0.6rem 0.8rem', background: i.folder === 'sent' ? '#f0fdf4' : '#f8fafc', borderRadius: 8 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                              {i.folder === 'sent' ? 'You' : meta ? short(meta.from) : i.messageId}
                            </span>
                            <span style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                              <SignatureChip meta={meta} />
                              <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>{new Date(i.lastEventAt).toLocaleString()}</span>
                            </span>
                          </div>
                          <div style={{ fontWeight: i.unread ? 600 : 400, marginTop: '0.25rem' }}>
                            {body ? (body.length > 400 ? `${body.slice(0, 400)}…` : body) : <i style={{ opacity: 0.6 }}>body in vault</i>}
                          </div>
                          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
                            {i.unread && (
                              <button className="btn" style={{ fontSize: '0.75rem' }} disabled={busy !== null} onClick={() => void post({ action: 'read', messageId: i.messageId }, i.messageId)}>
                                Mark read
                              </button>
                            )}
                            {i.folder !== 'archive' && i.folder !== 'sent' && (
                              <button className="btn" style={{ fontSize: '0.75rem' }} disabled={busy !== null} onClick={() => void post({ action: 'archive', messageId: i.messageId }, i.messageId)}>
                                Archive
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    <div style={{ fontSize: '0.72rem', opacity: 0.55 }}>
                      Bodies are vault-resident; every admission and decision is audit-backed. Reply from New message with the sender&apos;s name.
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {view && Object.keys(view.mandates).length > 0 && (
        <div className="dash-section" style={{ marginTop: '1rem' }}>
          <h2>Issued mandates</h2>
          <p style={{ fontSize: '0.85rem', opacity: 0.75 }}>
            Signed statements of your intent, each backed by a scoped on-chain delegation (revocable from
            Your delegations).
          </p>
          {Object.entries(view.mandates).map(([intId, m]) => {
            const c = view.cases.find((x) => x.id === intId);
            return (
              <div key={m.mandateId} style={{ padding: '0.6rem 0', borderBottom: '1px solid #f1f5f9', fontSize: '0.85rem' }}>
                <b>{c?.subject ?? intId}</b>
                <div style={{ opacity: 0.7 }}>
                  {m.allowedActions.join(', ')} · {m.resourceScope.resource}
                  {m.resourceScope.purpose ? ` · purpose: ${m.resourceScope.purpose}` : ''}
                  {m.constraints.expiresAt ? ` · until ${new Date(m.constraints.expiresAt).toLocaleDateString()}` : ''}
                  {' · delegation '}<code>{m.delegationHash.slice(0, 10)}…</code>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionShell>
  );
}
