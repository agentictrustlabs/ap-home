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
import { isCustodianOf } from '../../connect-client';
import { isDemoCustodyHome } from '../../lib/persona-custody';
import { agentClassOf } from '../../lib/agent-class';
import { resolveVia, signHashFor } from '../../home/onboarding';
import type { SignHash } from '../../connect-client';
import { studioScopesFor } from '../../lib/studio-view';
import { ensureStudioSelfGrant } from '../../lib/studio-self-grant';
import {
  getCardPage,
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

/** Which class of Smart Agent's Studio this is (ADR-0046's closed trichotomy). The typed suffixes map
 *  DOWN to these: `.team`/`.church`/`.circle` are org-class, `.svc`/`.workspace`/`.treasury`/`.registry`
 *  are service-class, `.me` is the person. A card belongs to the AGENT, so the Studio is the same in all
 *  three — only how the agent and its authority are resolved differs. */
export type StudioScopeKind = 'person' | 'org' | 'service';

export interface StudioAgent {
  session: Session | null;
  loaded: boolean;
  /** The managed agent's Smart Agent address — the canonical identifier (ADR-0010). */
  sa: Address | null;
  name: string;
  /** The authority this Studio runs on: the stewardship wire (delegator = the managed agent, delegate =
   *  the person) for an org or service, and the person's own self vault grant when they ARE the agent. */
  delegation: DelegationWire | null;
  relationship: 'steward' | 'member' | 'self';
  /** Set when the person's own grant could not be established — the screen says so instead of
   *  rendering an empty Studio that looks like "you have no cards". */
  authorityError: string | null;
  /** RENDER-only scope picture; the service re-checks every op. */
  scopes: StudioScope[];
  /** The person's custody signer for THIS agent's SA (routed by credential, never raw `session.via`). */
  signHashFor(): Promise<SignHash>;
}

/** Resolve the managed agent + its stewardship delegation for either workspace kind. */
export function useStudioAgent(kind: StudioScopeKind, address: string): StudioAgent {
  const { session, profile, agentAddress } = useSession();
  const token = session?.token ?? null;
  const { agents, loaded: agentsLoaded } = useManagedAgents(kind === 'service' ? token : null, 'any');
  const [orgs, setOrgs] = useState<MyOrg[] | null>(null);
  const [selfGrant, setSelfGrant] = useState<DelegationWire | null>(null);
  const [selfLoaded, setSelfLoaded] = useState(false);
  const [authorityError, setAuthorityError] = useState<string | null>(null);

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
  // The person's Studio is their own, and only ever their own: a person can steward another agent, but
  // they cannot hold a second person's card. The person route carries no address (there is exactly one
  // person here — the signed-in one), so an empty `address` means "me"; a non-empty one must still match.
  const isSelf = kind === 'person' && !!agentAddress && (address === '' || lc(agentAddress) === lc(address));

  const sa = (kind === 'person' ? (isSelf ? (agentAddress as Address) : null) : (svc?.agent ?? org?.orgAgent ?? null)) as Address | null;
  const delegation = kind === 'person'
    ? selfGrant
    : (((svc?.stewardshipDelegation as DelegationWire | undefined) ?? org?.stewardshipDelegation ?? null) ?? null);
  const relationship = kind === 'person' ? 'self' : ((svc?.relationship ?? org?.relationship ?? 'steward') as 'steward' | 'member');
  const loaded = kind === 'person' ? selfLoaded : kind === 'service' ? agentsLoaded : orgs !== null;

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

  // The person's grant: stored if it exists, otherwise ONE signature, once. Deliberately after `sign`
  // is defined — it is the same credential-routed signer every other Studio step uses.
  useEffect(() => {
    if (kind !== 'person') return;
    if (!session || !isSelf || !agentAddress) { setSelfLoaded(true); return; }
    let cancelled = false;
    setAuthorityError(null);
    void (async () => {
      try {
        // `sign` RESOLVES to the signer (it picks the credential first), so it is awaited, not passed.
        const g = await ensureStudioSelfGrant({ personSA: agentAddress as Address, token: session.token, signHash: await sign() });
        if (!cancelled) { setSelfGrant(g); setSelfLoaded(true); }
      } catch (e) {
        if (cancelled) return;
        setAuthorityError(e instanceof Error ? e.message : String(e));
        setSelfLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [kind, session, isSelf, agentAddress, sign]);

  return { session, loaded, sa, name: kind === 'person' ? (profile?.name ?? '') : (svc?.name ?? org?.orgName ?? ''), delegation, relationship, scopes, authorityError, signHashFor: sign };
}

/**
 * Can the person's SIGNER act for this managed agent's account on chain? Stewardship (the delegation the Studio
 * runs on) lets a person draft, sign and publish the CARD — vault and JWS work. Writing a name record or a
 * registry entry is a userOp on the managed agent's account and needs one of ITS custodians. The two are
 * different authorities (spec 347 §9): the Home says which one a step needs BEFORE the click, instead of an
 * "AA24 signature error" after it. `null` = cannot be known from here (a wallet home whose signer isn't cached),
 * in which case the attempt is allowed and the chain decides.
 */
export function useCanSignFor(sa: Address | null): boolean | null {
  const { session, agentAddress } = useSession();
  const [can, setCan] = useState<boolean | null>(null);
  useEffect(() => {
    if (!sa || !session) return;
    let cancelled = false;
    (async () => {
      const candidates: Address[] = [];
      if (agentAddress) candidates.push(agentAddress);
      try {
        if (await isDemoCustodyHome(session.token)) {
          const r = await fetch('/connect/demo-personas');
          const j = (await r.json()) as { personas?: Array<{ sa: string; custodian?: string }> };
          const me = (j.personas ?? []).find((p) => agentAddress && p.sa.toLowerCase() === agentAddress.toLowerCase());
          if (me?.custodian) candidates.push(me.custodian as Address);
        } else {
          if (!cancelled) setCan(null); // a wallet/KMS home: the signer isn't knowable without a prompt — let the chain decide
          if (!agentAddress) return;
        }
      } catch { /* fall through to the SA-only check */ }
      for (const c of candidates) {
        if (await isCustodianOf(sa, c)) { if (!cancelled) setCan(true); return; }
      }
      if (!cancelled) setCan(false);
    })();
    return () => { cancelled = true; };
  }, [sa, session, agentAddress]);
  return can;
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
    // No delegation, or no card named yet (Naming resolves the primary card first and passes '' until it
    // has one): there is nothing to ask for. Asking anyway spent a whole delegation-authorized round trip
    // to be told the empty string is not a card.
    if (!delegation || !cardResourceId) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    setError(null);
    // ONE call for the whole screen (`card.page`). Three separate reads meant three delegation mints and
    // three pairs of vault hops, and the screen waited on the slowest of them.
    void getCardPage(delegation, cardResourceId)
      .then(({ projections: p, bindings: b, ...d }) => {
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
