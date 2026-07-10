'use client';
// Registry — the discovery registry view (spec 279). Lists candidate named agents and their discovery
// registration, fetched THROUGH the discovery agent (demo-discovery-a2a → demo-discovery-mcp → GraphDB) —
// the home is a consumer of the knowledge base, it does not read the chain at scale (ADR-0012). Lets a
// steward register a named agent they custody: a custody-authorized on-chain write (RB-01: msg.sender ==
// subjectAgent) via the home's one-prompt ceremony, reflected here after the next index.
// Styling uses the shared inline theme (src/components/portal/theme.ts) — same amber tokens as the
// rest of the portal, since this page pre-dates the manage-card/btn-* CSS classes.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { loadRegistry, markCustody, REGISTRY, type AgentRegistryRow } from '../../../src/lib/registry';
import { canCheckCustody, registerAgent } from '../../../src/connect-client';
import { signHashFor, type Via } from '../../../src/home/onboarding';
import { cardSty, btnSty, btnPrimarySty, mono, mutedText, errorText, inputSty, badgeStyle, modalOverlaySty, shortAddr, type BadgeKind } from '../../../src/components/portal/theme';

function Badge({ kind, children }: { kind: BadgeKind; children: React.ReactNode }) {
  return <span style={badgeStyle(kind)}>{children}</span>;
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

  // Can we pre-check custody? passkey/wallet from local state; Google/social via the KMS C_sub (needs the
  // session token). If not, leave Register open and let the on-chain ceremony enforce RB-01.
  const canCheck = useMemo(() => canCheckCustody(session?.via, agentName, session?.token), [session?.via, agentName, session?.token]);

  const load = useCallback(async () => {
    setRows(null); setErr(null);
    try {
      const base = await loadRegistry();
      setRows(base); // render the list immediately…
      const marked = await markCustody(base, session?.via, agentName, session?.token); // …then refine with custody
      setRows(marked);
    } catch (e) { setErr(String(e)); }
  }, [session?.via, agentName, session?.token]);

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
      <p style={{ fontSize: '.8rem', ...mutedText, marginBottom: '1rem' }}>
        via {REGISTRY.source} · registry <code style={mono}>{shortAddr(REGISTRY.address)}</code>
        {rows && ` · ${rows.length} named agents · ${registered} registered`}
      </p>

      <input
        value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or address…"
        style={{ ...inputSty, width: '100%', marginBottom: '1.2rem' }}
      />

      {err ? <div style={cardSty}><b style={errorText}>Read error</b> <span style={mutedText}>{err}</span></div>
        : !rows ? <p style={mutedText}>Asking the discovery agent…</p>
        : (
          <div style={{ display: 'grid', gap: '.7rem' }}>
            {filtered.map((r) => {
              // Custodied by you = the on-chain custody check said so, OR it's your own person SA (always
              // shown, even if registered/unchecked).
              const isMine = r.mine === true || (!!agentAddress && r.subjectAgent.toLowerCase() === agentAddress.toLowerCase());
              // Offer Register only for agents you steward. When we can't pre-check (Google/KMS) we leave it
              // available for any not-registered agent — the on-chain ceremony rejects non-custodians.
              const canRegister = !r.registered && r.name && (isMine || !canCheck);
              return (
                <div key={r.subjectAgent} style={cardSty}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '.5rem', alignItems: 'center' }}>
                    <div>
                      <strong>{r.name ?? '(unnamed)'}</strong>{isMine && <span style={{ marginLeft: '.5rem' }}><Badge kind="neutral">you steward</Badge></span>}
                      <div style={{ ...mono, fontSize: '.74rem', ...mutedText, marginTop: '.2rem' }}>{shortAddr(r.subjectAgent)}</div>
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
            {filtered.length === 0 && <p style={mutedText}>No agents match “{q}”.</p>}
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
    <div role="dialog" aria-modal="true" style={modalOverlaySty} onClick={busy ? undefined : onClose}>
      <div style={{ ...cardSty, maxWidth: 540, width: '100%', padding: '1.5rem', boxShadow: 'var(--shadow-modal)' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0, marginBottom: '.6rem' }}>Register {row.name}</h3>
        {txHash !== null ? (
          <>
            <p style={{ fontSize: '.9rem', color: 'var(--color-sage-700)' }}><strong>Registered ✓</strong> — {row.name} is now in the discovery registry.</p>
            {txHash && <p style={{ ...mono, fontSize: '.78rem', ...mutedText, wordBreak: 'break-all' }}>tx {txHash}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button style={btnPrimarySty} onClick={onDone}>Done</button>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: '.88rem', color: 'var(--color-text-body)', marginTop: 0 }}>
              Make <strong>{row.name}</strong> discoverable. Its Smart Agent registers the entry itself — one custody prompt, gasless.
            </p>
            <dl style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: '.3rem .8rem', fontSize: '.82rem', margin: '1rem 0' }}>
              <dt style={mutedText}>registry</dt><dd>{REGISTRY.registryId}</dd>
              <dt style={mutedText}>entryId</dt><dd style={mono}>urn:ap:registry-entry:{row.name}</dd>
              <dt style={mutedText}>subjectAgent</dt><dd style={mono}>{shortAddr(row.subjectAgent)}</dd>
            </dl>
            <p style={{ fontSize: '.8rem', ...mutedText }}>
              The agent (custodied by you) executes <code style={mono}>registerEntry</code> — <code style={mono}>msg.sender == subjectAgent</code> (RB-01) — signed by your {via} credential, sponsored by the paymaster.
            </p>
            {error && <p style={{ fontSize: '.82rem', ...errorText, marginTop: '.6rem' }}>{error}</p>}
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
