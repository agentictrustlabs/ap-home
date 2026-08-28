'use client';
// Shared client state for the Interactions surfaces (spec 313): one fetch of
// the owner's inbox view + one POST helper, used by Inbox and Chats. The
// chat/inbox partition is DETERMINISTIC (spec 313 §2): a conversation is a
// chat iff none of its messages carries an interactionId and all are 'plain'.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ContextRefV1,
  ConversationDescriptorV1,
  ConversationSummaryV1,
  DirectMessageSummaryV1,
  FolderSummaryV1,
  InboxItemV1,
} from '@agenticprimitives/fabric/messaging';
import type { ActionCardV1, InteractionCaseV1, InteractionMandateV1 } from '@agenticprimitives/fabric/interactions';
import type { HomeInboxSummaryV1 } from '@agenticprimitives/home';
import type { Address } from '@agenticprimitives/types';
// spec 341 §5.1b — a person's send is their own agent's A2A delivery, not a Home write.
import { sendMessage, MessagingWireRequiredError, type SendMessageInput } from '../lib/messaging-send';

export interface EnvelopeMeta {
  from: string;
  subject?: string;
  /** V1 ONLY — absent on `ap.message.v2`. Branch on PRESENCE; absence is not "not plain". */
  kind?: string;
  /** Both versions. What the message does, which is what `kind` was standing in for. */
  performative: string;
  /** The causal edge — under V2 this is what makes something a reply (spec 340 §R.4). */
  inReplyTo?: string;
  interactionId?: string;
  contextRefs?: ContextRefV1[];
  signatureSigner?: string;
  createdAt: string;
  /** spec 328 / spec 324 §9 — acting-agent provenance (assistant-authored ⇒ "agent" chip). */
  actor?: string;
}

export interface InboxView {
  items: InboxItemV1[];
  folders: FolderSummaryV1[];
  summary: HomeInboxSummaryV1;
  cases: InteractionCaseV1[];
  cards: Record<string, ActionCardV1>;
  bodies: Record<string, string>;
  mandates: Record<string, InteractionMandateV1>;
  conversations: ConversationSummaryV1[];
  /** Slack-model DM buckets: one row per counterparty, folding every conversation with them. */
  directMessages: DirectMessageSummaryV1[];
  descriptors: Record<string, ConversationDescriptorV1>;
  envelopeMeta: Record<string, EnvelopeMeta>;
  /** Counterparty display names, keyed by lowercase 0x address (server reverse-resolves + caches). */
  names?: Record<string, string>;
}

/**
 * Shared Interactions view for a Home inbox. `targetAgent` scopes it to a managed org/service SA the person
 * controls (workspace-scoped Messages, spec 315); omitted → the person's own inbox. The server re-verifies
 * control on every read/action (`related-idx`), so passing an uncontrolled SA is a 403.
 */
export function useInboxView(session: { token: string } | null, targetAgent?: string, sender?: Address, stewardship?: unknown) {
  const [view, setView] = useState<InboxView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when a send needs the one-prompt ceremony (no wire, or a counterparty it does not cover).
   *  Kept separate from `error` because it is the one failure the person can actually resolve. */
  const [wireRequired, setWireRequired] = useState<MessagingWireRequiredError | null>(null);
  /** The send the wire refused — kept so approving the contact can finish it without retyping. */
  const [pendingSend, setPendingSend] = useState<{ input: Omit<SendMessageInput, 'person'>; key: string } | null>(null);
  const agentQs = targetAgent ? `?agent=${encodeURIComponent(targetAgent)}` : '';

  const refresh = useCallback(async () => {
    if (!session) return;
    const res = await fetch(`/connect/inbox${agentQs}`, { headers: { authorization: `Bearer ${session.token}` } });
    if (res.ok) {
      const next = (await res.json()) as InboxView;
      // VL-W4 — the list/poll is metadata-only (bodies:{}). MERGE so bodies already lazily fetched for an
      // open thread survive a re-poll (a plain setView would blank the open thread every 5s).
      setView((prev) => ({ ...next, bodies: { ...(prev?.bodies ?? {}), ...next.bodies } }));
    }
  }, [session, agentQs]);

  // VL-W4 — lazily fetch ONE conversation's bodies when its thread is opened, merged into the view. The
  // list never resolves bodies (zero KMS on first paint + on every poll); only the open thread pays.
  const loadThread = useCallback(
    async (conversationId: string) => {
      if (!session || !conversationId) return;
      const qs = `${agentQs ? agentQs + '&' : '?'}conversationId=${encodeURIComponent(conversationId)}`;
      const res = await fetch(`/connect/inbox${qs}`, { headers: { authorization: `Bearer ${session.token}` } });
      if (!res.ok) return;
      const thread = (await res.json()) as InboxView;
      setView((prev) => (prev ? { ...prev, bodies: { ...prev.bodies, ...thread.bodies } } : thread));
    },
    [session, agentQs],
  );

  // Rail previews — the LAST message of each DM bucket. Fetched by exact id, so the cost is one vault
  // read per bucket whose newest message the client has not seen yet, never one per message per poll.
  const loadPreviews = useCallback(
    async (messageIds: readonly string[]) => {
      if (!session || messageIds.length === 0) return;
      const qs = `${agentQs ? agentQs + '&' : '?'}messageIds=${encodeURIComponent(messageIds.slice(0, 50).join(','))}`;
      const res = await fetch(`/connect/inbox${qs}`, { headers: { authorization: `Bearer ${session.token}` } });
      if (!res.ok) return;
      const got = (await res.json()) as InboxView;
      setView((prev) => (prev ? { ...prev, bodies: { ...prev.bodies, ...got.bodies } } : got));
    },
    [session, agentQs],
  );

  // Initial load + light polling (5s, paused while the tab is hidden) so new
  // deliveries appear without a manual refresh.
  useEffect(() => {
    void refresh();
    const tick = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void refresh();
    };
    const id = setInterval(tick, 5000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const post = useCallback(
    async (body: Record<string, unknown>, key: string): Promise<boolean> => {
      if (!session) return false;
      setBusy(key);
      setError(null);
      try {
        const res = await fetch('/connect/inbox', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
          body: JSON.stringify(targetAgent ? { ...body, agent: targetAgent } : body),
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
    [session, refresh, targetAgent],
  );

  /**
   * SEND — spec 341 §5.1b. Every composer, reply, invite and inquiry in this app goes through here.
   *
   * A PERSON's send is an A2A delivery performed by their own agent, under a wire they signed. The
   * Home is not in the transfer at all: the browser asks the agent, the agent signs and sends, the
   * recipient's gate re-verifies everything (ADR-0044).
   *
   * AN ORG SENDS THE SAME WAY. It has no session of its own, so the caller supplies `stewardship` —
   * the org→person delegation the agent re-verifies (delegator is the org, delegate is the caller,
   * stewardship shape not merely member access, ERC-1271-live). There is now ONE path: the branch on
   * principal kind that lived here, and the `/connect/inbox` send it fell back to, are both gone.
   */
  const send = useCallback(
    async (input: Omit<SendMessageInput, 'person'>, key: string): Promise<boolean> => {
      if (!session) return false;
      if (!sender) {
        setError('no sending agent — reload and try again');
        return false;
      }
      setBusy(key);
      setError(null);
      setWireRequired(null);
      try {
        await sendMessage({ person: sender, ...(stewardship ? { stewardship } : {}), ...input });
        setPendingSend(null);
        await refresh();
        return true;
      } catch (e) {
        if (e instanceof MessagingWireRequiredError) {
          setWireRequired(e);
          setPendingSend({ input, key });
        }
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [session, refresh, sender, stewardship],
  );

  /**
   * After the one-prompt approval: clear the refusal and FINISH the send it interrupted. The person
   * already wrote the message and already signed — asking them to reload, or to type it again, turns
   * one ceremony into three steps. No pending send ⇒ just clears (the approval came from elsewhere).
   */
  const approved = useCallback(async (): Promise<boolean> => {
    setWireRequired(null);
    setError(null);
    const p = pendingSend;
    setPendingSend(null);
    if (!p) { await refresh(); return true; }
    return send(p.input, p.key);
  }, [pendingSend, send, refresh]);

  /** Deterministic chat test (spec 313 §2). */
  const isChat = useCallback(
    (conversationId: string): boolean => {
      if (!view) return false;
      const items = view.items.filter((i) => i.conversationId === conversationId);
      if (items.length === 0) return false;
      return items.every((i) => {
        const meta = view.envelopeMeta[i.messageId];
        // spec 340 §R.4 — the rule is PER VERSION, not translated. `kind === 'plain'` was enforcing
        // two things at once: "INFORM-shaped" and "an original, not a reply". The second vanishes
        // under V2, where a reply is an INFORM too, so mapping it forward to `performative ===
        // 'INFORM'` would silently widen this filter. V1 keeps the exact comparison it had; V2 uses
        // the causal edge, which is what the taxonomy had been standing in for.
        if (i.interactionId) return false;
        if (!meta) return true;
        return meta.kind !== undefined
          ? meta.kind === 'plain'
          : meta.performative === 'INFORM' && !meta.inReplyTo;
      });
    },
    [view],
  );

  const chatConversations = useMemo(
    () => (view?.conversations ?? []).filter((c) => isChat(c.conversationId)),
    [view, isChat],
  );
  const inboxConversations = useMemo(
    () => (view?.conversations ?? []).filter((c) => !isChat(c.conversationId)),
    [view, isChat],
  );

  return { view, refresh, loadThread, loadPreviews, post, send, approved, wireRequired, setWireRequired, busy, error, setError, chatConversations, inboxConversations };
}

export const shortId = (caip: string): string => {
  const addr = caip.match(/0x[0-9a-fA-F]{40}$/)?.[0];
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : caip.slice(0, 18);
};

/** Display label for an agent: claimed name when the server resolved one, short address otherwise. */
export const agentLabel = (caip: string, names?: Record<string, string>): string => {
  const addr = caip.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase();
  return (addr && names?.[addr]) || shortId(caip);
};
