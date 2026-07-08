'use client';
// Inbox (spec 313) — the Gmail-tempo triage surface: pending approvals, typed
// requests, receipts, and system mail. Pure person↔person chats live in
// /chats (deterministic partition, spec 313 §2); discovery lives in /find.
// Approve/Deny feed the interactions state machine through the audited store;
// they grant nothing — issuance routes through the authority packages.
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Address } from '@agenticprimitives/types';
import type { InteractionCaseV1 } from '@agenticprimitives/interactions';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { connectWallet, personalSign } from '../../../src/lib/wallet';
import { passkeySignHash, googleSignHash, type SignHash } from '../../../src/connect-client';
import { issueMandateForCase } from '../../../src/home/mandate';
import { useInboxView, shortId, agentLabel } from '../../../src/home/use-inbox';

async function signerFor(via: string, agent: Address, token: string): Promise<SignHash> {
  const v = via.toLowerCase();
  if (v === 'wallet') {
    const addr = await connectWallet();
    return (h) => personalSign(addr, h);
  }
  if (v === 'google') return googleSignHash(agent, token);
  return passkeySignHash;
}

const PENDING_STATES = ['delivered', 'seen', 'triaged'];

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
      {r.label ?? `${r.kind}:${shortId(r.id)}`}
    </button>
  );
}

export default function InboxPage() {
  const { session, agentAddress } = useSession();
  const { view, post, busy, error, setError, inboxConversations } = useInboxView(session);
  const [folder, setFolder] = useState<string>('all');
  const [context, setContext] = useState<{ kind: string; id: string; label?: string } | null>(null);
  const [openConv, setOpenConv] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);

  // W5: approving an access-request ISSUES — scoped delegation + mandate,
  // both signed under the ROOT credential, ERC-1271-verified server-side.
  const approveWithMandate = useCallback(
    async (c: InteractionCaseV1) => {
      if (!session || !agentAddress) return;
      setLocalBusy(true);
      setError(null);
      try {
        const sign = await signerFor(session.via, agentAddress as Address, session.token);
        const { mandate } = await issueMandateForCase(c, agentAddress as Address, sign);
        await post({ action: 'transition', transition: 'approve', interactionId: c.id, mandate }, c.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLocalBusy(false);
      }
    },
    [session, agentAddress, post, setError],
  );

  const pendingCases = useMemo(
    () => (view?.cases ?? []).filter((c) => PENDING_STATES.includes(c.state)),
    [view],
  );

  const itemsByConv = useMemo(() => {
    const map = new Map<string, typeof view extends null ? never : NonNullable<typeof view>['items']>();
    for (const i of view?.items ?? []) {
      if (i.folder === 'trash') continue;
      map.set(i.conversationId, [...(map.get(i.conversationId) ?? []), i]);
    }
    return map;
  }, [view]);

  const conversations = useMemo(() => {
    let rows = inboxConversations;
    if (context) rows = rows.filter((c) => c.contextRefs.some((r) => r.kind === context.kind && r.id === context.id));
    if (folder !== 'all') rows = rows.filter((c) => (itemsByConv.get(c.conversationId) ?? []).some((i) => i.folder === folder));
    return rows;
  }, [inboxConversations, context, folder, itemsByConv]);

  const anyBusy = busy !== null || localBusy;

  if (!session) {
    return (
      <SectionShell title="Inbox">
        <p>Not signed in.</p>
      </SectionShell>
    );
  }

  return (
    <SectionShell title="Inbox">
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}

      {/* ── Needs attention (Gmail/Outlook focused-triage band) ── */}
      {pendingCases.length > 0 && (
        <div className="dash-section" style={{ border: '1px solid #fcd34d', background: '#fffbeb', borderRadius: 8, padding: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>Needs attention · {pendingCases.length} pending</h2>
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
                      {card?.summary ?? `${c.kind} · from ${agentLabel(c.requester, view?.names)} · state: ${c.state}`}
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
                          disabled={anyBusy}
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

      <div className="dash-section" style={{ marginTop: '1rem' }}>
        <h2>Mail{view?.summary ? ` · ${view.summary.unreadTotal} unread` : ''}</h2>

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

        {conversations.length === 0 ? (
          <p style={{ opacity: 0.7 }}>
            No mail. Chats live in <Link href="/chats">Chats</Link>; find people in <Link href="/find">Find</Link>.
            External deliveries land via <code>/connect/inbox/deliver</code>.
          </p>
        ) : (
          conversations.map((conv) => {
            const convItems = (itemsByConv.get(conv.conversationId) ?? []).filter((i) => folder === 'all' || i.folder === folder);
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
                      {view?.descriptors[conv.conversationId]?.title ?? newestMeta?.subject ?? `From ${newestMeta ? agentLabel(newestMeta.from, view?.names) : '…'}`}
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

                {isOpen && (
                  <div style={{ padding: '0 0 0.75rem 1rem', display: 'grid', gap: '0.5rem' }}>
                    {[...convItems].reverse().map((i) => {
                      const meta = view?.envelopeMeta[i.messageId];
                      const body = view?.bodies[i.messageId];
                      return (
                        <div key={i.messageId} style={{ padding: '0.6rem 0.8rem', background: i.folder === 'sent' ? '#f0fdf4' : '#f8fafc', borderRadius: 8 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                              {i.folder === 'sent' ? 'You' : meta ? agentLabel(meta.from, view?.names) : i.messageId}
                            </span>
                            <span style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                              {meta?.signatureSigner ? (
                                <span style={{ fontSize: '0.72rem', color: '#15803d' }} title={meta.signatureSigner}>
                                  ✓ signed by {shortId(meta.signatureSigner)}
                                </span>
                              ) : (
                                <span style={{ fontSize: '0.72rem', color: '#92400e' }}>⚠ no signature</span>
                              )}
                              <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>{new Date(i.lastEventAt).toLocaleString()}</span>
                            </span>
                          </div>
                          <div style={{ fontWeight: i.unread ? 600 : 400, marginTop: '0.25rem' }}>
                            {body ? (body.length > 400 ? `${body.slice(0, 400)}…` : body) : <i style={{ opacity: 0.6 }}>body in vault</i>}
                          </div>
                          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
                            {i.unread && (
                              <button className="btn" style={{ fontSize: '0.75rem' }} disabled={anyBusy} onClick={() => void post({ action: 'read', messageId: i.messageId }, i.messageId)}>
                                Mark read
                              </button>
                            )}
                            {i.folder !== 'archive' && i.folder !== 'sent' && (
                              <button className="btn" style={{ fontSize: '0.75rem' }} disabled={anyBusy} onClick={() => void post({ action: 'archive', messageId: i.messageId }, i.messageId)}>
                                Archive
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    <div style={{ fontSize: '0.72rem', opacity: 0.55 }}>
                      Bodies are vault-resident; every admission and decision is audit-backed.
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
