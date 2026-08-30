'use client';
// Data hooks for the Agent Card & Projection Studio. ONE lookup path per workspace kind, then the same
// stewardship `DelegationWire` for every Studio call (guide.md "The transport"): the Home talks to the
// managed agent's A2A service, never to MCP (ADR-0044).
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { StudioScope } from '@agenticprimitives/home';
import { useSession, type Session } from '../../context/session';
import { AGENTS_CHANGED_EVENT, useManagedAgents } from '../portal/ManagedAgents';
import { listMyOrgs, type MyOrg } from '../../connect-client';
import { agentClassOf } from '../../lib/agent-class';
import { resolveVia, signHashFor } from '../../home/onboarding';
import type { SignHash } from '../../connect-client';
import { studioScopesFor } from '../../lib/studio-view';
import {
  getCard,
  listBindings,
  listCards,
  listProjections,
  type CardDetail,
  type CardListEntry,
  type DelegationWire,
  type StoredProjection,
} from '../../studio-client';
import type { ExternalIdentityBindingV1 } from '@agenticprimitives/registry-kit/projection';

const lc = (s: string): string => s.toLowerCase();

/** Fired after any release/publish mutation so the list, editor and any open approval card re-read. */
export const CARD_CHANGED_EVENT = 'ap:card-changed';

export function notifyCardChanged(): void {
  try {
    window.dispatchEvent(new Event(CARD_CHANGED_EVENT));
  } catch {
    /* SSR / no window — nothing to notify */
  }
}

function useChangeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = (): void => setTick((t) => t + 1);
    window.addEventListener(CARD_CHANGED_EVENT, bump);
    window.addEventListener(AGENTS_CHANGED_EVENT, bump);
    return () => {
      window.removeEventListener(CARD_CHANGED_EVENT, bump);
      window.removeEventListener(AGENTS_CHANGED_EVENT, bump);
    };
  }, []);
  return tick;
}

export type StudioScopeKind = 'org' | 'service';

export interface StudioAgent {
  session: Session | null;
  loaded: boolean;
  /** The managed agent's Smart Agent address — the canonical identifier (ADR-0010). */
  sa: Address | null;
  name: string;
  /** The stewardship wire (delegator = the managed agent, delegate = the person). */
  delegation: DelegationWire | null;
  relationship: 'steward' | 'member';
  /** RENDER-only scope picture; the service re-checks every op. */
  scopes: StudioScope[];
  /** The person's custody signer for THIS agent's SA (routed by credential, never raw `session.via`). */
  signHashFor(): Promise<SignHash>;
}

/** Resolve the managed agent + its stewardship delegation for either workspace kind. */
export function useStudioAgent(kind: StudioScopeKind, address: string): StudioAgent {
  const { session, profile } = useSession();
  const token = session?.token ?? null;
  const { agents, loaded: agentsLoaded } = useManagedAgents(kind === 'service' ? token : null, 'any');
  const [orgs, setOrgs] = useState<MyOrg[] | null>(null);

  useEffect(() => {
    if (kind !== 'org' || !token) return;
    let cancelled = false;
    void listMyOrgs(token, 'any')
      .then((all) => {
        if (!cancelled) setOrgs(all);
      })
      .catch(() => {
        if (!cancelled) setOrgs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, token]);

  const svc = kind === 'service' ? agents.find((a) => agentClassOf(a.kind) === 'service' && lc(a.agent) === lc(address)) : undefined;
  const org = kind === 'org' ? orgs?.find((o) => lc(o.orgAgent) === lc(address)) : undefined;

  const sa = (svc?.agent ?? org?.orgAgent ?? null) as Address | null;
  const delegation = ((svc?.stewardshipDelegation as DelegationWire | undefined) ?? org?.stewardshipDelegation ?? null) ?? null;
  const relationship = (svc?.relationship ?? org?.relationship ?? 'steward') as 'steward' | 'member';
  const loaded = kind === 'service' ? agentsLoaded : orgs !== null;

  const scopes = useMemo(
    () => (delegation ? studioScopesFor({ principalKind: 'human', relationship }) : []),
    [delegation, relationship],
  );

  const sign = useCallback(async (): Promise<SignHash> => {
    if (!session || !sa) throw new Error('sign in first');
    // Route the signer by the home's ACTUAL credential — a raw `session.via` pops MetaMask on a
    // KMS/social home (memory: sign by credential, not via).
    return signHashFor(resolveVia(profile?.credential, session.via), sa, { token: session.token });
  }, [session, profile?.credential, sa]);

  return { session, loaded, sa, name: svc?.name ?? org?.orgName ?? '', delegation, relationship, scopes, signHashFor: sign };
}

export interface CardsState {
  cards: CardListEntry[];
  projections: StoredProjection[];
  loaded: boolean;
  error: string | null;
  reload(): void;
}

export function useCards(delegation: DelegationWire | null): CardsState {
  const [cards, setCards] = useState<CardListEntry[]>([]);
  const [projections, setProjections] = useState<StoredProjection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(0);
  const tick = useChangeTick();

  useEffect(() => {
    if (!delegation) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    setError(null);
    void Promise.all([listCards(delegation), listProjections(delegation).catch(() => [] as StoredProjection[])])
      .then(([c, p]) => {
        if (cancelled) return;
        setCards(c);
        setProjections(p);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [delegation, tick, manual]);

  return { cards, projections, loaded, error, reload: () => setManual((n) => n + 1) };
}

export interface CardState {
  detail: CardDetail | null;
  projections: StoredProjection[];
  bindings: ExternalIdentityBindingV1[];
  loaded: boolean;
  error: string | null;
  reload(): void;
  /** Replace the in-memory detail after a mutation, without a round trip. */
  patch(next: CardDetail): void;
}

export function useCardDetail(delegation: DelegationWire | null, cardResourceId: string): CardState {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [projections, setProjections] = useState<StoredProjection[]>([]);
  const [bindings, setBindings] = useState<ExternalIdentityBindingV1[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(0);
  const tick = useChangeTick();

  useEffect(() => {
    if (!delegation) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    setError(null);
    void Promise.all([
      getCard(delegation, cardResourceId),
      listProjections(delegation).catch(() => [] as StoredProjection[]),
      listBindings(delegation).catch(() => [] as ExternalIdentityBindingV1[]),
    ])
      .then(([d, p, b]) => {
        if (cancelled) return;
        setDetail(d);
        setProjections(p);
        setBindings(b);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [delegation, cardResourceId, tick, manual]);

  return { detail, projections, bindings, loaded, error, reload: () => setManual((n) => n + 1), patch: setDetail };
}

/**
 * Read a one-shot deep-link query param and clear it from the URL, so a refresh doesn't re-trigger the
 * scroll/highlight (design §1.3).
 */
export function useOneShotParam(name: string): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const v = url.searchParams.get(name);
      if (v === null) return;
      setValue(v);
      url.searchParams.delete(name);
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* no window / bad URL — nothing to read */
    }
  }, [name]);
  return value;
}
