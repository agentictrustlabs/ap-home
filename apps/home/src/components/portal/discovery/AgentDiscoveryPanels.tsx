'use client';
// The Discovery band, read for ONE managed agent (spec 279 / 280 / 282; ADR-0046).
//
// A workspace, treasury or registry agent is discovered exactly the way a person is — it is a Smart Agent
// like any other. So the questions are the same five the person nav already asks, and these panels answer
// them for the agent named in the URL rather than for the signed-in person:
//   Registry     — is it in the discovery knowledge base?
//   Naming       — what is it called, and does that name resolve to it?
//   Capabilities — what has it DECLARED it can do (the public `atl:capabilities` record discovery ranks)?
// Trust graph and Network are shared components: the graph is one graph seen from this agent's seat, and
// the substrate is one substrate.
//
// SCOPE, said plainly: the public tier only. A person's Capabilities page also edits PRIVATE capability
// claims held in their own vault; the equivalent for a managed agent lives in THAT agent's vault behind
// its stewardship delegation, and is not wired here — so this page says what it shows instead of implying
// the private tier is empty.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { loadRegistry, markCustody, type AgentRegistryRow } from '../../../lib/registry';
import { getCapabilities, setCapabilities, capabilityIdFor, type CapabilityClaim } from '../../../connect-client';
import { getCapabilityDefinition } from '@agenticprimitives/capability-claims';
import { AgentCapabilitiesEditor } from '../capabilities/AgentCapabilitiesEditor';
import { resolveVia, signHashFor } from '../../../home/onboarding';
import { reverseAgentName } from '../../../lib/reverse-name';
import { badgeStyle, cardSty, mono, mutedText, errorText, shortAddr } from '../theme';
import { BusyButton } from '../../shared/BusyButton';

const lc = (s: string) => s.toLowerCase();

/** Run one async action with a busy flag — every network/signing button shows work in progress. */
function useAction(): { busy: boolean; run(fn: () => Promise<void>): () => void } {
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: (fn) => () => { setBusy(true); void fn().finally(() => setBusy(false)); },
  };
}

/** The one row for THIS agent out of the discovery knowledge base. `null` while loading, `undefined`
 *  when the knowledge base has never heard of it (which is an ANSWER — it means not indexed). */
function useAgentRow(agent: string): { row: AgentRegistryRow | null | undefined; err: string | null; reload(): void } {
  const { session, agentName } = useSession();
  const [row, setRow] = useState<AgentRegistryRow | null | undefined>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const load = useCallback(async () => {
    setRow(null); setErr(null);
    try {
      const base = await loadRegistry();
      const marked = await markCustody(base, session?.via, agentName, session?.token);
      setRow(marked.find((r) => lc(r.subjectAgent) === lc(agent)));
    } catch (e) { setErr(String(e)); }
  }, [agent, session?.via, session?.token, agentName]);
  useEffect(() => { void load(); }, [load, tick]);
  return { row, err, reload: () => setTick((n) => n + 1) };
}

export function AgentNamingPanel({ agent, name }: { agent: Address; name: string | null }) {
  const { row } = useAgentRow(agent);
  const resolves = row ? lc(row.subjectAgent) === lc(agent) : null;
  // The REGISTERED name, reverse-resolved from the chain. `name` is the workspace's display label, which
  // for a workspace is a human phrase ("Northern Colorado Field") and not a name anything can resolve —
  // showing it here read as though that phrase were the agent's name in the naming service.
  const [onChain, setOnChain] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void reverseAgentName(agent).then((n) => { if (!cancelled) setOnChain(n); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [agent]);
  const registered = onChain ?? row?.name ?? null;
  return (
    <div style={cardSty}>
      <h3 style={{ margin: '0 0 .5rem' }}>Name</h3>
      <p style={{ ...mutedText, fontSize: '.82rem', marginTop: 0 }}>
        What this agent is called, and whether that name points back at this address. The name is the
        public handle; the address is the identity (ADR-0010) — a name is a facet of it, never the other
        way round.
      </p>
      {registered ? (
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '.3rem .8rem', fontSize: '.84rem', margin: 0 }}>
          <dt style={mutedText}>Name</dt><dd style={{ margin: 0 }}><strong>{registered}</strong></dd>
          {name && name !== registered && (
            <>
              <dt style={mutedText}>Shown as</dt><dd style={{ margin: 0 }}>{name}</dd>
            </>
          )}
          <dt style={mutedText}>Resolves to</dt>
          <dd style={{ margin: 0 }}>
            <code style={mono}>{agent}</code>{' '}
            {resolves === null ? null : resolves ? <span style={badgeStyle('ok')}>● matches</span> : <span style={badgeStyle('warn')}>does not match</span>}
          </dd>
        </dl>
      ) : (
        <p style={{ ...mutedText, fontSize: '.82rem' }}>
          Nothing in the naming service resolves to this agent yet. It still has an identity — its address
          — but nothing can look it up by a handle, and it has no public host to serve a card at.
        </p>
      )}
    </div>
  );
}

export function AgentCapabilitiesPanel({ agent, name }: { agent: Address; name: string | null }) {
  const { session, profile } = useSession();
  const [claims, setClaims] = useState<CapabilityClaim[] | null>(null);
  const [published, setPublished] = useState<string[]>([]);
  const [busy, setBusy] = useState<'save' | 'publish' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // The SAME editor a person gets, on the SAME record key. An org and a service used to get a
  // comma box here — a second UI, over a second shape, for one concept — which is how a person's
  // capabilities became structured rows while an org's stayed free text nobody could match on.
  //
  // The published IDS are read from chain; the structured rows come from what the catalog defines for
  // them. An id with no definition still shows, badged "not in catalog" by the editor, because it is
  // live on chain and hiding it would leave the agent advertising something its steward cannot see.
  const load = useCallback(async () => {
    const ids = await getCapabilities(agent);
    setPublished(ids);
    setClaims(ids.map((id) => {
      const def = getCapabilityDefinition(id);
      return {
        label: def?.title ?? id, capabilityId: id, description: def?.description,
        relation: 'hasSkill', asserted: true, createdAt: Date.now(),
      };
    }));
  }, [agent]);
  useEffect(() => { void load(); }, [load]);

  const publish = async (): Promise<void> => {
    setMsg(null);
    if (!session || !name) { setMsg('This agent needs a name before its capabilities can be published.'); return; }
    setBusy('publish');
    try {
      const ids = (claims ?? []).filter((c) => c.asserted).map((c) => capabilityIdFor(c));
      const signHash = await signHashFor(resolveVia(profile?.credential, session.via), agent, { token: session.token });
      const res = await setCapabilities(agent, name, ids, signHash);
      if (res.ok) { setPublished(ids); setMsg('Published. Discovery ranks against this list.'); }
      else setMsg(res.error);
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  return (
    <div style={cardSty}>
      <h3 style={{ margin: '0 0 .5rem' }}>Capabilities</h3>
      <p style={{ ...mutedText, fontSize: '.82rem', marginTop: 0 }}>
        What this agent can do — the public <code style={mono}>atl:capabilities</code> record on its
        profile, which the discovery matcher ranks and its agent card advertises. Owner-signed and
        gasless; a custodian of this agent signs once.
      </p>
      {claims === null ? <p style={mutedText}>Reading the profile…</p> : (
        <AgentCapabilitiesEditor
          claims={claims}
          onChange={setClaims}
          published={published}
          busy={busy}
          onPublish={publish}
          {...(name ? {} : { disabledReason: 'This agent needs a name before its capabilities can be published.' })}
        />
      )}
      {msg && <p style={{ ...mutedText, fontSize: '.82rem', marginTop: '.4rem' }}>{msg}</p>}
    </div>
  );
}
