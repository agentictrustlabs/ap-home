'use client';
// The agentic inbox (spec 310 W3 / spec 309 W6) — the Home's review surface:
// messages by folder plus the pending-approvals queue. Approve/Deny/Ask-info
// buttons feed the interactions state machine through the audited store; they
// grant nothing — issuance routes through the authority packages.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { FolderSummaryV1, InboxItemV1, MessageEnvelopeV1 } from '@agenticprimitives/messaging';
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

interface InboxView {
  items: InboxItemV1[];
  folders: FolderSummaryV1[];
  summary: HomeInboxSummaryV1;
  cases: InteractionCaseV1[];
  cards: Record<string, ActionCardV1>;
  bodies: Record<string, string>;
  mandates: Record<string, InteractionMandateV1>;
}

const PENDING_STATES = ['delivered', 'seen', 'triaged'];

export default function InboxPage() {
  const { session, agentAddress, agentName } = useSession();
  const [view, setView] = useState<InboxView | null>(null);
  const [folder, setFolder] = useState<string>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      if (!session) return;
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
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
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
      // The public delivery pipeline verifies label → agent on-chain; without
      // a claimed name there is no label to deliver under. Fail visible.
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
        priority: 'high',
      };
      const interactionCase: InteractionCaseV1 = {
        version: 'ap.interaction.v1',
        id: interactionId,
        kind: 'access-request',
        subject: 'Read contact email (purpose: notifications)',
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

  const pendingCases = useMemo(
    () => (view?.cases ?? []).filter((c) => PENDING_STATES.includes(c.state)),
    [view],
  );
  const items = useMemo(
    () => (view?.items ?? []).filter((i) => (folder === 'all' ? i.folder !== 'trash' : i.folder === folder)),
    [view, folder],
  );

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
      description="Messages and pending requests for everything acting in your name. Approving here records a decision — authority is issued separately, on your terms."
    >
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}

      {pendingCases.length > 0 && (
        <div className="dash-section">
          <h2>Pending approvals ({pendingCases.length})</h2>
          {pendingCases.map((c) => {
            const card = view?.cards[c.id];
            const actions = card?.allowedActions ?? [
              { actionId: 'approve', label: 'Approve', transition: 'approve' as const, style: 'primary' as const },
              { actionId: 'deny', label: 'Deny', transition: 'deny' as const, style: 'destructive' as const },
            ];
            return (
              <div key={c.id} className="dash-card" style={{ marginBottom: '0.75rem', padding: '1rem', border: '1px solid #e5e7eb', borderRadius: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                  <div>
                    <b>{card?.title ?? c.subject}</b>
                    <div style={{ fontSize: '0.85rem', opacity: 0.75 }}>
                      {card?.summary ?? `${c.kind} · from ${c.requester.slice(0, 24)}… · state: ${c.state}`}
                    </div>
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

      <div className="dash-section" style={{ marginTop: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
          <h2>
            Messages{view?.summary ? ` · ${view.summary.unreadTotal} unread` : ''}
          </h2>
          <button className="btn" onClick={() => void sendDemoRequest()} disabled={busy !== null}>
            {busy === 'demo' ? 'Delivering…' : 'Send yourself a demo request'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', margin: '0.75rem 0', flexWrap: 'wrap' }}>
          <button className="btn" style={folder === 'all' ? { fontWeight: 700 } : undefined} onClick={() => setFolder('all')}>
            All
          </button>
          {(view?.folders ?? []).map((f) => (
            <button key={f.folder} className="btn" style={folder === f.folder ? { fontWeight: 700 } : undefined} onClick={() => setFolder(f.folder)}>
              {f.folder} ({f.unread}/{f.total})
            </button>
          ))}
        </div>

        {items.length === 0 ? (
          <p style={{ opacity: 0.7 }}>Nothing here yet. Deliveries land via <code>/connect/inbox/deliver</code>.</p>
        ) : (
          items.map((i) => {
            const body = view?.bodies[i.messageId];
            return (
              <div key={i.messageId} style={{ padding: '0.75rem 0', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                  <div>
                    <span style={{ fontWeight: i.unread ? 700 : 400 }}>
                      {body ? (body.length > 120 ? `${body.slice(0, 120)}…` : body) : i.messageId}
                    </span>
                    <div style={{ fontSize: '0.8rem', opacity: 0.65 }}>
                      {i.folder} · {new Date(i.lastEventAt).toLocaleString()}
                      {i.labels.length > 0 ? ` · ${i.labels.join(', ')}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {i.unread && (
                      <button className="btn" disabled={busy !== null} onClick={() => void post({ action: 'read', messageId: i.messageId }, i.messageId)}>
                        Mark read
                      </button>
                    )}
                    {i.folder !== 'archive' && (
                      <button className="btn" disabled={busy !== null} onClick={() => void post({ action: 'archive', messageId: i.messageId }, i.messageId)}>
                        Archive
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </SectionShell>
  );
}
