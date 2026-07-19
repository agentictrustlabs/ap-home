'use client';
// "Connected hosts" — a person-readable picture of how a treasury Smart Agent relates to the app's hosted
// services (spec 283/284). When a treasury has bound its endpoints on-chain (the connect-treasury ceremony),
// this shows the relationship:  treasury → A2A agent (other agents talk to it) + MCP server (apps/tools
// access it).  The A2A row drills into the live agent-card OFFERINGS; the MCP row into how ACCESS + the VAULT
// work. Endpoints are read on-chain (the canonical source) from the AgentNameResolver, keyed by namehash.
import { useEffect, useState, type CSSProperties } from 'react';
import { createPublicClient, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { namehash } from '@agenticprimitives/agent-naming';
import { CONTRACTS } from '../../lib/chain';

const NAME_RESOLVER_ABI = [
  { type: 'function', name: 'getString', stateMutability: 'view', inputs: [{ name: 'subject', type: 'bytes32' }, { name: 'predicate', type: 'bytes32' }], outputs: [{ type: 'string' }] },
] as const;
const pred = (key: string) => keccak256(toBytes(`atl:${key}`));

/** Read the treasury's bound a2a/mcp endpoint records on-chain (spec 280; AgentNameResolver, node-keyed). */
function useHostBindings(name: string): { a2a: string; mcp: string; loaded: boolean } {
  const [state, setState] = useState({ a2a: '', mcp: '', loaded: false });
  useEffect(() => {
    if (!name) { setState({ a2a: '', mcp: '', loaded: true }); return; }
    let cancelled = false;
    const pub = createPublicClient({ chain: baseSepolia, transport: http('/a2a/rpc') });
    const node = namehash(name) as Hex;
    const read = (key: string) => pub.readContract({ address: CONTRACTS.agentNameResolver as Address, abi: NAME_RESOLVER_ABI, functionName: 'getString', args: [node, pred(key)] }).catch(() => '') as Promise<string>;
    Promise.all([read('a2aEndpoint'), read('mcpEndpoint')])
      .then(([a2a, mcp]) => { if (!cancelled) setState({ a2a, mcp, loaded: true }); })
      .catch(() => { if (!cancelled) setState({ a2a: '', mcp: '', loaded: true }); });
    return () => { cancelled = true; };
  }, [name]);
  return state;
}

/** One A2A card OFFERING. `CardSkill` mirrors the card's `skills[]` wire shape — legacy name, kept. */
interface CardSkill { id: string; name?: string; effect?: string }
const hostLabel = (url: string) => { try { return new URL(url).host; } catch { return url; } };

const wrap: CSSProperties = { marginTop: '.6rem', paddingTop: '.55rem', borderTop: '1px solid var(--color-border)' };
const node: CSSProperties = { fontSize: '.78rem', fontWeight: 700, color: 'var(--color-text-primary)', background: 'var(--color-surface-sunken)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-8)', padding: '.3rem .5rem', display: 'inline-block' };
const hostRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: '.4rem', margin: '.35rem 0 0', fontSize: '.78rem', flexWrap: 'wrap' };
const tag: CSSProperties = { fontWeight: 700, color: 'var(--color-amber-700)', fontSize: '.7rem', letterSpacing: '.02em' };
const linkBtn: CSSProperties = { background: 'none', border: 'none', color: 'var(--color-amber-700)', cursor: 'pointer', padding: 0, font: 'inherit', fontSize: '.76rem', textDecoration: 'underline' };
const muted: CSSProperties = { color: 'var(--color-text-muted)' };
const drawer: CSSProperties = { marginTop: '.4rem', padding: '.5rem .6rem', background: 'var(--color-surface-raised)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-8)', fontSize: '.76rem' };

/** The relationship picture + the two drill-downs. Renders only once at least one endpoint is bound. */
export function ConnectedHosts({ name, address }: { name: string; address: string }) {
  const { a2a, mcp, loaded } = useHostBindings(name);
  const [open, setOpen] = useState<'a2a' | 'mcp' | null>(null);

  if (!loaded || (!a2a && !mcp)) return null; // not connected yet → show nothing (the Connect button stands)

  return (
    <div style={wrap}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--color-text-body)', letterSpacing: '.04em', textTransform: 'uppercase' }}>Connected hosts</span>
        <span style={{ fontSize: '.7rem', ...muted }}>on-chain · spec 280</span>
      </div>
      <p style={{ margin: '.3rem 0 .5rem', ...muted, fontSize: '.76rem' }}>
        Your treasury is the money agent. It’s reachable through two hosted services — others <b>talk</b> to it
        (A2A) and apps <b>access</b> it (MCP) — both pointing back at this one address.
      </p>

      {/* the picture: treasury → {A2A, MCP} */}
      <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center' }}>
        <span style={node} title={address}>🏦 {name}</span>
        <span style={{ ...muted, fontSize: '1rem' }}>⇒</span>
        <div style={{ flex: 1 }}>
          {a2a && (
            <div style={hostRow}>
              <span style={tag}>A2A</span>
              <span className="mono" style={{ ...muted }}>{hostLabel(a2a)}</span>
              <button type="button" style={linkBtn} onClick={() => setOpen(open === 'a2a' ? null : 'a2a')}>
                {open === 'a2a' ? 'hide offerings' : 'view offerings ▸'}
              </button>
            </div>
          )}
          {mcp && (
            <div style={hostRow}>
              <span style={tag}>MCP</span>
              <span className="mono" style={{ ...muted }}>{hostLabel(mcp)}</span>
              <button type="button" style={linkBtn} onClick={() => setOpen(open === 'mcp' ? null : 'mcp')}>
                {open === 'mcp' ? 'hide access' : 'view access & vault ▸'}
              </button>
            </div>
          )}
        </div>
      </div>

      {open === 'a2a' && a2a && <A2aSkills endpoint={a2a} />}
      {open === 'mcp' && mcp && <McpAccess endpoint={mcp} />}
    </div>
  );
}

/** Live agent-card OFFERINGS — the A2A `skills[]` array is an ADVERTISEMENT (`apdisc:Offering`), not a
 *  capability claim and not a playbook (facet-registries.md §7). The `skills` JSON key, the `CardSkill`
 *  type and the `A2aSkills` name are the wire/legacy names and stay; the prose says "offerings".
 *  Fetched from the A2A host's bound endpoint (card visibility ≠ authorization). */
function A2aSkills({ endpoint }: { endpoint: string }) {
  const [skills, setSkills] = useState<CardSkill[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSkills(null); setErr(null);
    fetch(`${endpoint.replace(/\/+$/, '')}/.well-known/agent-card.json?view=authenticated`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((c: { skills?: CardSkill[] }) => { if (!cancelled) setSkills(c.skills ?? []); })
      .catch((e) => { if (!cancelled) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { cancelled = true; };
  }, [endpoint]);
  return (
    <div style={drawer}>
      <b>Offerings — what this agent advertises</b>
      {!skills && !err && <span style={{ ...muted }}> · loading…</span>}
      {err && <span style={{ color: 'var(--color-danger)' }}> · couldn’t reach the card ({err})</span>}
      {skills && skills.length > 0 && (
        <div style={{ display: 'flex', gap: '.3rem', flexWrap: 'wrap', marginTop: '.35rem' }}>
          {skills.map((s) => (
            <span key={s.id} style={{ background: 'var(--color-amber-50)', color: 'var(--color-amber-700)', borderRadius: 'var(--radius-4)', padding: '.12rem .4rem', fontSize: '.72rem' }}>
              {s.name ?? s.id}{s.effect ? ` · ${s.effect}` : ''}
            </span>
          ))}
        </div>
      )}
      {skills && skills.length === 0 && <span style={{ ...muted }}> · no offerings on the card.</span>}
      <p style={{ margin: '.4rem 0 0', ...muted, fontSize: '.72rem' }}>Other agents call these over A2A; every call still re-checks delegation + policy before anything runs.</p>
    </div>
  );
}

/** How apps ACCESS the treasury through the MCP server, and how the VAULT is scoped. Lead with the access
 *  MODEL (always true), and surface the live tool list when the host is reachable. */
function McpAccess({ endpoint }: { endpoint: string }) {
  const [tools, setTools] = useState<string[] | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTools(null); setReachable(null);
    fetch(`${endpoint.replace(/\/+$/, '')}/`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: { tools?: string[] }) => { if (!cancelled) { setTools(d.tools ?? []); setReachable(true); } })
      .catch(() => { if (!cancelled) setReachable(false); });
    return () => { cancelled = true; };
  }, [endpoint]);
  return (
    <div style={drawer}>
      <b>Access &amp; vault</b>
      <ul style={{ margin: '.35rem 0 0', paddingLeft: '1.1rem', ...muted, fontSize: '.74rem' }}>
        <li><b>Read &amp; resolve</b> are open to connected apps (balances, networks, market data, plan a payment).</li>
        <li><b>Move value</b> (transfer / swap / sign) needs a <b>scoped delegation you granted</b> — never automatic.</li>
        <li><b>Vault:</b> the treasury’s private data stays in its own vault; apps read it through <b>granted scopes</b>, never a copy.</li>
      </ul>
      {tools && tools.length > 0 && (
        <div style={{ marginTop: '.35rem' }}>
          <span style={{ ...muted, fontSize: '.72rem' }}>Live tools: </span>
          {tools.map((t) => <code key={t} style={{ fontSize: '.7rem', marginRight: '.3rem' }}>{t}</code>)}
        </div>
      )}
      {reachable === false && <p style={{ margin: '.35rem 0 0', ...muted, fontSize: '.72rem' }}>(Live tool list unavailable — the MCP host isn’t reachable from here right now; the access rules above still hold.)</p>}
    </div>
  );
}
