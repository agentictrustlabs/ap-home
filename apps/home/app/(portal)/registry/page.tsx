'use client';
// Registry — the discovery registry view (spec 279). Lists candidate named agents and their discovery
// registration, fetched THROUGH the discovery agent (demo-discovery-a2a → demo-discovery-mcp → GraphDB) —
// the home is a consumer of the knowledge base, it does not read the chain at scale (ADR-0012). Lets a
// steward register a named agent they custody: a custody-authorized on-chain write (RB-01: msg.sender ==
// subjectAgent) via the home's one-prompt ceremony, reflected here after the next index.
// Styling is self-contained inline (the app's class system has no card/btn/badge classes).
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { loadRegistry, markCustody, REGISTRY, type AgentRegistryRow } from '../../../src/lib/registry';
import { connectedCredential, registerAgent } from '../../../src/connect-client';
import { signHashFor, type Via } from '../../../src/home/onboarding';

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const cardSty: CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, boxShadow: '0 1px 3px rgba(15,23,42,.07)', padding: '1rem 1.1rem' };
const btnSty: CSSProperties = { padding: '.5rem .9rem', borderRadius: 10, fontWeight: 700, fontSize: '.85rem', cursor: 'pointer', border: '1.5px solid #c7d2fe', background: '#fff', color: '#4f46e5', font: 'inherit' };
const btnPrimarySty: CSSProperties = { ...btnSty, background: '#4f46e5', color: '#fff', border: '1.5px solid #4f46e5' };
const mono: CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };

type BadgeKind = 'ok' | 'warn' | 'err' | 'neutral';
const BADGE: Record<BadgeKind, CSSProperties> = {
  ok: { color: '#047857', background: '#ecfdf5', borderColor: '#6ee7b7' },
  warn: { color: '#b45309', background: '#fffbeb', borderColor: '#fcd34d' },
  err: { color: '#b91c1c', background: '#fef2f2', borderColor: '#fca5a5' },
  neutral: { color: '#475569', background: '#f1f5f9', borderColor: '#e2e8f0' },
};
function Badge({ kind, children }: { kind: BadgeKind; children: React.ReactNode }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.3rem', fontSize: '.72rem', fontWeight: 800, padding: '.2rem .55rem', borderRadius: 999, border: '1px solid', ...BADGE[kind] }}>{children}</span>;
}
function StatusBadge({ row }: { row: AgentRegistryRow }) {
  return row.registered ? <Badge kind="ok">● registered</Badge> : <Badge kind="neutral">not registered</Badge>;
}

export default function RegistryPage() {
  const { session, agentAddress, agentName } = useSession();
  const [rows, setRows] = useState<AgentRegistryRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [registerFor, setRegisterFor] = useState<AgentRegistryRow | null>(null);

  // Can we pre-check custody client-side? (passkey/wallet yes; Google/KMS resolves C_sub server-side, so
  // we leave its rows ungated and let the on-chain ceremony enforce RB-01 at register time.)
  const canCheckCustody = useMemo(() => !!connectedCredential(session?.via, agentName), [session?.via, agentName]);

  const load = useCallback(async () => {
    setRows(null); setErr(null);
    try {
      const base = await loadRegistry();
      setRows(base); // render the list immediately…
      const marked = await markCustody(base, session?.via, agentName); // …then refine with custody
      setRows(marked);
    } catch (e) { setErr(String(e)); }
  }, [session?.via, agentName]);

  const refresh = () => { void load(); };
  useEffect(() => { void load(); }, [load]);

  const filtered = (rows ?? []).filter((r) => {
    const t = q.trim().toLowerCase();
    return !t || (r.name ?? '').toLowerCase().includes(t) || r.subjectAgent.toLowerCase().includes(t);
  });
  const registered = (rows ?? []).filter((r) => r.registered).length;

  return (
    <SectionShell
      title="Registry"
      description="Candidate named agents and their discovery registration, served by the discovery agent over the knowledge base. Register an agent you steward to make it discoverable."
    >
      <p style={{ fontSize: '.8rem', color: '#64748b', marginBottom: '1rem' }}>
        via {REGISTRY.source} · registry <code style={mono}>{shortAddr(REGISTRY.address)}</code>
        {rows && ` · ${rows.length} named agents · ${registered} registered`}
      </p>

      <input
        value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or address…"
        style={{ width: '100%', padding: '.6rem .8rem', borderRadius: 10, border: '1.5px solid #cbd5e1', font: 'inherit', marginBottom: '1.2rem' }}
      />

      {err ? <div style={cardSty}><b style={{ color: '#b91c1c' }}>Read error</b> <span style={{ color: '#64748b' }}>{err}</span></div>
        : !rows ? <p style={{ color: '#64748b' }}>Asking the discovery agent…</p>
        : (
          <div style={{ display: 'grid', gap: '.7rem' }}>
            {filtered.map((r) => {
              // Custodied by you = the on-chain custody check said so, OR it's your own person SA (always
              // shown, even if registered/unchecked).
              const isMine = r.mine === true || (!!agentAddress && r.subjectAgent.toLowerCase() === agentAddress.toLowerCase());
              // Offer Register only for agents you steward. When we can't pre-check (Google/KMS) we leave it
              // available for any not-registered agent — the on-chain ceremony rejects non-custodians.
              const canRegister = !r.registered && r.name && (isMine || !canCheckCustody);
              return (
                <div key={r.subjectAgent} style={cardSty}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '.5rem', alignItems: 'center' }}>
                    <div>
                      <strong>{r.name ?? '(unnamed)'}</strong>{isMine && <span style={{ marginLeft: '.5rem' }}><Badge kind="neutral">you steward</Badge></span>}
                      <div style={{ ...mono, fontSize: '.74rem', color: '#64748b', marginTop: '.2rem' }}>{shortAddr(r.subjectAgent)}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
                      {!r.shaclConforms && <Badge kind="warn">SHACL ⚠</Badge>}
                      <StatusBadge row={r} />
                      {canRegister && <button style={btnPrimarySty} onClick={() => setRegisterFor(r)}>Register</button>}
                    </div>
                  </div>
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
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }} onClick={busy ? undefined : onClose}>
      <div style={{ ...cardSty, maxWidth: 540, width: '100%', padding: '1.5rem', boxShadow: '0 24px 60px rgba(15,23,42,.35)' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0, marginBottom: '.6rem' }}>Register {row.name}</h3>
        {txHash !== null ? (
          <>
            <p style={{ fontSize: '.9rem', color: '#047857' }}><strong>Registered ✓</strong> — {row.name} is now in the discovery registry.</p>
            {txHash && <p style={{ ...mono, fontSize: '.78rem', color: '#64748b', wordBreak: 'break-all' }}>tx {txHash}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button style={btnPrimarySty} onClick={onDone}>Done</button>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: '.88rem', color: '#475569', marginTop: 0 }}>
              Make <strong>{row.name}</strong> discoverable. Its Smart Agent registers the entry itself — one custody prompt, gasless.
            </p>
            <dl style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: '.3rem .8rem', fontSize: '.82rem', margin: '1rem 0' }}>
              <dt style={{ color: '#64748b' }}>registry</dt><dd>{REGISTRY.registryId}</dd>
              <dt style={{ color: '#64748b' }}>entryId</dt><dd style={mono}>urn:ap:registry-entry:{row.name}</dd>
              <dt style={{ color: '#64748b' }}>subjectAgent</dt><dd style={mono}>{shortAddr(row.subjectAgent)}</dd>
            </dl>
            <p style={{ fontSize: '.8rem', color: '#64748b' }}>
              The agent (custodied by you) executes <code style={mono}>registerEntry</code> — <code style={mono}>msg.sender == subjectAgent</code> (RB-01) — signed by your {via} credential, sponsored by the paymaster.
            </p>
            {error && <p style={{ fontSize: '.82rem', color: '#b91c1c', marginTop: '.6rem' }}>{error}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '.6rem', marginTop: '1rem' }}>
              <button style={btnSty} onClick={onClose} disabled={busy}>Cancel</button>
              <button style={btnPrimarySty} onClick={run} disabled={busy || !row.name}>{busy ? 'Registering…' : 'Sign & register'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
