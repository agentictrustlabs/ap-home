'use client';
// Registry — the discovery registry view (spec 279). Lists every named agent under the home's TLD with
// its AgentRegistryBase registration (registered? status? card/binding-proof hashes), and lets a steward
// register a named agent they custody. Reads are storage-view only (ADR-0012); registration is a
// custody-authorized on-chain write (RB-01: msg.sender == subjectAgent) driven by the home's ceremony.
import { useEffect, useState } from 'react';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { loadRegistry, REGISTRY, type AgentRegistryRow } from '../../../src/lib/registry';
import { registerAgent } from '../../../src/connect-client';
import { signHashFor, type Via } from '../../../src/home/onboarding';

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const shortHash = (h?: string) => (h ? `${h.slice(0, 14)}…${h.slice(-4)}` : '—');

function StatusBadge({ row }: { row: AgentRegistryRow }) {
  if (!row.registered) return <span className="badge badge-soon">not registered</span>;
  if (row.live) return <span className="badge badge-live">● registered · active</span>;
  if (row.status === 'revoked') return <span className="badge badge-err">✕ revoked</span>;
  if (row.status === 'suspended') return <span className="badge badge-warn">⏸ suspended</span>;
  return <span className="badge badge-warn">○ {row.status === 'active' ? 'expired' : row.status}</span>;
}

export default function RegistryPage() {
  const { session, agentAddress } = useSession();
  const [rows, setRows] = useState<AgentRegistryRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [registerFor, setRegisterFor] = useState<AgentRegistryRow | null>(null);

  const refresh = () => { setRows(null); loadRegistry().then(setRows).catch((e) => setErr(String(e))); };
  useEffect(() => { loadRegistry().then(setRows).catch((e) => setErr(String(e))); }, []);

  const filtered = (rows ?? []).filter((r) => {
    const t = q.trim().toLowerCase();
    return !t || (r.name ?? '').toLowerCase().includes(t) || r.subjectAgent.toLowerCase().includes(t);
  });
  const registered = (rows ?? []).filter((r) => r.registered).length;

  return (
    <SectionShell
      title="Registry"
      description="Every named agent on Base Sepolia and its discovery registration. Reads come straight from agent-naming + AgentRegistryBase; register an agent you steward to make it discoverable."
    >
      <p style={{ fontSize: '.8rem', color: '#64748b', marginBottom: '1rem' }}>
        registry <code>{shortAddr(REGISTRY.address)}</code> · chain {REGISTRY.chainId}
        {rows && ` · ${rows.length} named agents · ${registered} registered`}
      </p>

      <input
        value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or address…"
        style={{ width: '100%', padding: '.6rem .8rem', borderRadius: 10, border: '1.5px solid #cbd5e1', font: 'inherit', marginBottom: '1.2rem' }}
      />

      {err ? <div className="card"><b style={{ color: '#b91c1c' }}>Read error</b> <span style={{ color: '#64748b' }}>{err}</span></div>
        : !rows ? <p style={{ color: '#64748b' }}>Reading agent-naming + the registry…</p>
        : (
          <div style={{ display: 'grid', gap: '.7rem' }}>
            {filtered.map((r) => {
              const isMine = agentAddress && r.subjectAgent.toLowerCase() === agentAddress.toLowerCase();
              return (
                <div key={r.subjectAgent} className="card" style={{ padding: '1rem 1.1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '.5rem', alignItems: 'center' }}>
                    <div>
                      <strong>{r.name ?? '(unnamed)'}</strong>{isMine && <span className="badge" style={{ marginLeft: '.5rem' }}>you</span>}
                      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '.74rem', color: '#64748b', marginTop: '.2rem' }}>{shortAddr(r.subjectAgent)}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
                      <StatusBadge row={r} />
                      {!r.registered && <button className="btn btn-primary" onClick={() => setRegisterFor(r)} disabled={!r.name}>Register</button>}
                    </div>
                  </div>
                  {r.registered && (
                    <dl style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '.25rem .8rem', fontSize: '.82rem', marginTop: '.7rem' }}>
                      <dt style={{ color: '#64748b' }}>cardHash</dt><dd style={{ fontFamily: 'ui-monospace, monospace' }}>{shortHash(r.cardHash)}</dd>
                      <dt style={{ color: '#64748b' }}>bindingProofHash</dt><dd style={{ fontFamily: 'ui-monospace, monospace' }}>{shortHash(r.bindingProofHash)}</dd>
                      <dt style={{ color: '#64748b' }}>expires</dt><dd>{r.expiresAt ? new Date(r.expiresAt * 1000).toISOString().slice(0, 10) : 'non-expiring'}</dd>
                    </dl>
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && <p style={{ color: '#64748b' }}>No agents match “{q}”.</p>}
          </div>
        )}

      {registerFor && (
        <RegisterPanel
          row={registerFor}
          via={session?.via ?? 'passkey'}
          token={session?.token ?? null}
          onClose={() => setRegisterFor(null)}
          onDone={() => { setRegisterFor(null); refresh(); }}
        />
      )}
    </SectionShell>
  );
}

/** Register ceremony: the agent's SA executes registerEntry itself (RB-01), signed by the home credential
 *  (signHashFor) and sponsored — ONE custody prompt, gasless. */
function RegisterPanel({ row, via: viaStr, token, onClose, onDone }: {
  row: AgentRegistryRow; via: string; token: string | null; onClose: () => void; onDone: () => void;
}) {
  const via: Via = viaStr.toLowerCase() === 'wallet' ? 'wallet' : viaStr.toLowerCase() === 'google' ? 'google' : 'passkey';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const run = async () => {
    if (!row.name) return;
    setBusy(true); setError(null);
    try {
      const signHash = await signHashFor(via, row.subjectAgent, token ? { token } : undefined);
      const res = await registerAgent(row.subjectAgent, row.name, signHash);
      if (res.ok) setTxHash(res.txHash ?? '');
      else setError(res.error);
    } catch (e) { setError(String((e as Error)?.message ?? e)); }
    finally { setBusy(false); }
  };

  return (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '1rem' }} onClick={busy ? undefined : onClose}>
      <div className="card" style={{ maxWidth: 540, width: '100%', padding: '1.4rem' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Register {row.name}</h3>
        {txHash !== null ? (
          <>
            <p style={{ fontSize: '.9rem', color: '#047857' }}><strong>Registered ✓</strong> — {row.name} is now in the discovery registry.</p>
            {txHash && <p style={{ fontSize: '.78rem', color: '#64748b', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>tx {txHash}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button className="btn btn-primary" onClick={onDone}>Done</button>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: '.88rem', color: '#475569' }}>
              Make <strong>{row.name}</strong> discoverable. Its Smart Agent registers the entry itself — one custody prompt, gasless.
            </p>
            <dl style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: '.3rem .8rem', fontSize: '.82rem', margin: '1rem 0' }}>
              <dt style={{ color: '#64748b' }}>registry</dt><dd>{REGISTRY.registryId}</dd>
              <dt style={{ color: '#64748b' }}>entryId</dt><dd style={{ fontFamily: 'ui-monospace, monospace' }}>urn:ap:registry-entry:{row.name}</dd>
              <dt style={{ color: '#64748b' }}>subjectAgent</dt><dd style={{ fontFamily: 'ui-monospace, monospace' }}>{shortAddr(row.subjectAgent)}</dd>
            </dl>
            <p style={{ fontSize: '.8rem', color: '#64748b' }}>
              The agent (custodied by you) executes <code>registerEntry</code> — <code>msg.sender == subjectAgent</code> (RB-01) — signed by your {via} credential, sponsored by the paymaster.
            </p>
            {error && <p style={{ fontSize: '.82rem', color: '#b91c1c', marginTop: '.6rem' }}>{error}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '.6rem', marginTop: '1rem' }}>
              <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn btn-primary" onClick={run} disabled={busy || !row.name}>{busy ? 'Registering…' : 'Sign & register'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
