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
  FolderSummaryV1,
  InboxItemV1,
} from '@agenticprimitives/fabric/messaging';
import type { ActionCardV1, InteractionCaseV1, InteractionMandateV1 } from '@agenticprimitives/fabric/interactions';
import type { HomeInboxSummaryV1 } from '@agenticprimitives/home';

export interface EnvelopeMeta {
  from: string;
  subject?: string;
  kind: string;
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
export function useInboxView(session: { token: string } | null, targetAgent?: string) {
  const [view, setView] = useState<InboxView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  /** Deterministic chat test (spec 313 §2). */
  const isChat = useCallback(
    (conversationId: string): boolean => {
      if (!view) return false;
      const items = view.items.filter((i) => i.conversationId === conversationId);
      if (items.length === 0) return false;
      return items.every((i) => {
        const meta = view.envelopeMeta[i.messageId];
        return !i.interactionId && (meta ? meta.kind === 'plain' : true);
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

  return { view, refresh, loadThread, post, busy, error, setError, chatConversations, inboxConversations };
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
