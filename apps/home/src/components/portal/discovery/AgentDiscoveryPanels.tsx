'use client';
// The Discovery band, read for ONE managed agent (spec 279 / 280 / 282; ADR-0046).
//
// A workspace, treasury or registry agent is discovered exactly the way a person is — it is a Smart Agent
// like any other. So the questions are the same five the person nav already asks, and these panels answer
// them for the agent named in the URL rather than for the signed-in person:
//   Registry     — is it in the discovery knowledge base?
//   Naming       — what is it called, and does that name resolve to it?
//   Capabilities — what has it DECLARED it can do (the public `atl:skills` projection discovery ranks)?
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
import { loadRegistry, markCustody, REGISTRY, type AgentRegistryRow } from '../../../lib/registry';
import { getSkills, setSkills, registerAgent, canCheckCustody } from '../../../connect-client';
import { resolveVia, signHashFor } from '../../../home/onboarding';
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

export function AgentRegistryPanel({ agent, name }: { agent: Address; name: string | null }) {
  const { session, profile } = useSession();
  const { row, err, reload } = useAgentRow(agent);
  const [msg, setMsg] = useState<string | null>(null);
  const act = useAction();

  const register = async (): Promise<void> => {
    setMsg(null);
    if (!session || !name) { setMsg('This agent needs a name before it can be registered.'); return; }
    try {
      const signHash = await signHashFor(resolveVia(profile?.credential, session.via), agent, { token: session.token });
      const res = await registerAgent(agent, name, signHash);
      setMsg(res.ok ? 'Registered. It appears here after the next index run.' : res.error);
      if (res.ok) reload();
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div style={cardSty}>
      <h3 style={{ margin: '0 0 .5rem' }}>Discovery registry</h3>
      <p style={{ ...mutedText, fontSize: '.82rem', marginTop: 0 }}>
        Whether this agent has an entry in the discovery knowledge base — what a directory or another
        agent finds when it searches. Read through the discovery agent, not the chain (ADR-0012).
      </p>
      {err && <p style={errorText}>{err}</p>}
      {row === null && !err && <p style={mutedText}>Checking the registry…</p>}
      {row === undefined && (
        <>
          <p><span style={badgeStyle('neutral')}>not in the registry</span></p>
          <p style={{ ...mutedText, fontSize: '.82rem' }}>
            The knowledge base has no entry for this agent. Registering is an on-chain write the agent&rsquo;s
            OWN account makes (RB-01: only the subject may register itself), so it needs a custodian of this
            agent, not just any signer.
          </p>
          <BusyButton className="btn-primary" busy={act.busy} busyLabel="Registering…" onClick={act.run(register)}>Register this agent</BusyButton>
        </>
      )}
      {row && (
        <>
          <p>
            {row.registered ? <span style={badgeStyle('ok')}>● registered</span> : <span style={badgeStyle('neutral')}>indexed, not registered</span>}
            {row.shaclConforms ? <span style={{ marginLeft: '.5rem', ...badgeStyle('ok') }}>shape valid</span> : <span style={{ marginLeft: '.5rem', ...badgeStyle('warn') }}>shape not checked</span>}
          </p>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '.3rem .8rem', fontSize: '.84rem', margin: 0 }}>
            <dt style={mutedText}>Name</dt><dd style={{ margin: 0 }}>{row.name ?? <span style={mutedText}>none</span>}</dd>
            <dt style={mutedText}>Address</dt><dd style={{ margin: 0 }}><code style={mono}>{row.subjectAgent}</code></dd>
            <dt style={mutedText}>Registry</dt><dd style={{ margin: 0 }}><code style={mono}>{shortAddr(REGISTRY.address)}</code> · via {REGISTRY.source}</dd>
          </dl>
          {!row.registered && <div style={{ marginTop: '.7rem' }}><BusyButton className="btn-primary" busy={act.busy} busyLabel="Registering…" onClick={act.run(register)}>Register this agent</BusyButton></div>}
        </>
      )}
      {msg && <p style={{ ...mutedText, fontSize: '.82rem', marginTop: '.6rem' }}>{msg}</p>}
    </div>
  );
}

export function AgentNamingPanel({ agent, name }: { agent: Address; name: string | null }) {
  const { row } = useAgentRow(agent);
  const resolves = row ? lc(row.subjectAgent) === lc(agent) : null;
  return (
    <div style={cardSty}>
      <h3 style={{ margin: '0 0 .5rem' }}>Name</h3>
      <p style={{ ...mutedText, fontSize: '.82rem', marginTop: 0 }}>
        What this agent is called, and whether that name points back at this address. The name is the
        public handle; the address is the identity (ADR-0010) — a name is a facet of it, never the other
        way round.
      </p>
      {name ? (
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '.3rem .8rem', fontSize: '.84rem', margin: 0 }}>
          <dt style={mutedText}>Name</dt><dd style={{ margin: 0 }}><strong>{name}</strong></dd>
          <dt style={mutedText}>Resolves to</dt>
          <dd style={{ margin: 0 }}>
            <code style={mono}>{agent}</code>{' '}
            {resolves === null ? null : resolves ? <span style={badgeStyle('ok')}>● matches</span> : <span style={badgeStyle('warn')}>does not match</span>}
          </dd>
        </dl>
      ) : (
        <p style={{ ...mutedText, fontSize: '.82rem' }}>
          This agent has no name yet. It still has an identity — its address — but nothing can look it up
          by a human-readable handle, and it has no public host to serve a card at.
        </p>
      )}
    </div>
  );
}

export function AgentCapabilitiesPanel({ agent, name }: { agent: Address; name: string | null }) {
  const { session, profile } = useSession();
  const [skills, setSkillList] = useState<string[] | null>(null);
  const [draft, setDraft] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const act = useAction();

  const load = useCallback(async () => {
    const s = await getSkills(agent);
    setSkillList(s); setDraft(s.join(', '));
  }, [agent]);
  useEffect(() => { void load(); }, [load]);

  const save = async (): Promise<void> => {
    setMsg(null);
    if (!session || !name) { setMsg('This agent needs a name before its capabilities can be published.'); return; }
    const next = draft.split(',').map((x) => x.trim()).filter(Boolean);
    try {
      const signHash = await signHashFor(resolveVia(profile?.credential, session.via), agent, { token: session.token });
      const res = await setSkills(agent, name, next, signHash);
      if (res.ok) { setSkillList(next); setMsg('Published. Discovery ranks against this list.'); }
      else setMsg(res.error);
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div style={cardSty}>
      <h3 style={{ margin: '0 0 .5rem' }}>Declared capabilities</h3>
      <p style={{ ...mutedText, fontSize: '.82rem', marginTop: 0 }}>
        What this agent says it can do — the PUBLIC <code style={mono}>atl:skills</code> projection on its
        profile, which the discovery matcher ranks. Owner-signed and gasless; a custodian of this agent
        signs once.
      </p>
      {skills === null ? <p style={mutedText}>Reading the profile…</p> : (
        <>
          <label htmlFor="agent-caps" style={{ ...mutedText, fontSize: '.78rem', display: 'block', marginBottom: '.3rem' }}>
            Comma-separated capability labels
          </label>
          <input
            id="agent-caps"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. coordination, translation, scheduling"
            style={{ width: '100%', padding: '.45rem .6rem', borderRadius: 8, border: '1px solid var(--c-g200)', font: 'inherit' }}
          />
          <div style={{ marginTop: '.7rem' }}>
            <BusyButton className="btn-primary" busy={act.busy} busyLabel="Publishing…" onClick={act.run(save)} disabled={draft === (skills ?? []).join(', ')}>
              Publish capabilities
            </BusyButton>
          </div>
          <p style={{ ...mutedText, fontSize: '.78rem', marginTop: '.6rem' }}>
            This is the public tier only. Private capability CLAIMS live in the agent&rsquo;s own vault behind
            its stewardship delegation and are not edited here.
          </p>
        </>
      )}
      {msg && <p style={{ ...mutedText, fontSize: '.82rem', marginTop: '.4rem' }}>{msg}</p>}
    </div>
  );
}
