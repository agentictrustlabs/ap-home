'use client';
// Agent Naming Service (spec 280). Manage the names you steward and publish the OPT-IN, owner-authorized,
// PUBLIC connection-bootstrap record (kind + optional pre-select address) so a returning person on a fresh
// device can discover how to connect to your Smart Agent by name. Publishing is always an explicit action
// here (never automatic); the address toggle is clearly labeled "public" because the bootstrap read is a
// public directory lookup by necessity (ADR-0040 amendment). Owner-signed, gasless — one custody prompt.
// Self-contained inline styles (the app's class system has no card/btn/badge classes).
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { loadRegistry, markCustody, type AgentRegistryRow } from '../../../src/lib/registry';
import { setConnectionInfo, resolveCredential, claimName } from '../../../src/connect-client';
import { signHashFor, type Via } from '../../../src/home/onboarding';
import { nameLabel, CONNECT_DOMAIN } from '../../../src/lib/domain';
import type { Address } from '@agenticprimitives/types';
import type { ConnectionKind } from '@agenticprimitives/agent-naming';

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const cardSty: CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, boxShadow: '0 1px 3px rgba(15,23,42,.07)', padding: '1rem 1.1rem' };
const btnSty: CSSProperties = { padding: '.5rem .9rem', borderRadius: 10, fontWeight: 700, fontSize: '.85rem', cursor: 'pointer', border: '1.5px solid #c7d2fe', background: '#fff', color: '#4f46e5', font: 'inherit' };
const btnPrimarySty: CSSProperties = { ...btnSty, background: '#4f46e5', color: '#fff', border: '1.5px solid #4f46e5' };
const mono: CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };
const BADGE: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: '.3rem', fontSize: '.72rem', fontWeight: 800, padding: '.2rem .55rem', borderRadius: 999, border: '1px solid', color: '#047857', background: '#ecfdf5', borderColor: '#6ee7b7' };
const NEUTRAL: CSSProperties = { ...BADGE, color: '#475569', background: '#f1f5f9', borderColor: '#e2e8f0' };

const KINDS: ConnectionKind[] = ['wallet', 'google', 'youversion', 'passkey', 'multi'];
const viaToKind = (via: string | undefined): ConnectionKind => {
  const v = (via ?? '').toLowerCase();
  if (v === 'wallet') return 'wallet';
  if (v === 'youversion') return 'youversion';
  if (v === 'google') return 'google';
  if (v === 'passkey') return 'passkey';
  return 'passkey';
};

interface NameRow extends AgentRegistryRow {
  connectionKind: ConnectionKind | null;
  connectionAddress: string | null;
}

const toViaForSign = (via: string | undefined): Via => {
  const v = (via ?? '').toLowerCase();
  if (v === 'wallet') return 'wallet';
  if (v === 'google') return 'google';
  if (v === 'youversion') return 'youversion';
  return 'passkey';
};

export default function NamingPage() {
  const { session, agentName, agentAddress, agentDeployed, refreshProfile } = useSession();
  const [rows, setRows] = useState<NameRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editFor, setEditFor] = useState<NameRow | null>(null);
  // The connected home is deployed but NAMELESS (spec 257 name-deferral, e.g. Google onboarding) → offer
  // the nameless→named transition right here, then chain into "publish connection".
  const isNameless = !!agentAddress && agentDeployed && !agentName;

  const load = useCallback(async () => {
    setRows(null); setErr(null);
    try {
      const base = await loadRegistry();
      const marked = await markCustody(base, session?.via, agentName, session?.token);
      // Names you steward (custody confirmed) — the ones you can manage here.
      const mine = marked.filter((r) => r.mine === true && r.name);
      // Fetch each name's published connection record (name-info now returns it).
      const withConn = await Promise.all(mine.map(async (r) => {
        const info = await fetch(`/connect/name-info?name=${encodeURIComponent(r.name!)}`).then((x) => x.json()).catch(() => ({}));
        return { ...r, connectionKind: (info?.connectionKind ?? null) as ConnectionKind | null, connectionAddress: info?.connectionAddress ?? null };
      }));
      setRows(withConn.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')));
    } catch (e) { setErr(String(e)); }
  }, [session?.via, agentName, session?.token]);
  useEffect(() => { void load(); }, [load]);

  return (
    <SectionShell
      title="Naming Service"
      description="Manage the names you steward. Publish an opt-in connection record so you can re-connect to your agent by name on a new device — you choose what's shared."
    >
      {/* Nameless → named transition (spec 257/280). Deployed-but-unnamed home: claim a name, then
          optionally publish a connection — all from here. */}
      {isNameless && agentAddress && (
        <ClaimNameCard
          agent={agentAddress}
          via={toViaForSign(session?.via)}
          token={session?.token ?? null}
          onNamed={(claimedName) => {
            void refreshProfile();
            void load();
            // Chain straight into "publish connection" for the freshly-named agent.
            setEditFor({ name: claimedName, subjectAgent: agentAddress, registered: false, shaclConforms: true, mine: true, connectionKind: null, connectionAddress: null });
          }}
        />
      )}

      <div style={{ ...cardSty, background: '#fffbeb', borderColor: '#fcd34d', marginBottom: '1.1rem', fontSize: '.82rem', color: '#92400e' }}>
        <strong>Connection records are public.</strong> They live on the public naming service so a returning person can
        discover how to connect — there is no private way to do this (you have no credential yet at that point). Publishing
        the <strong>kind</strong> (wallet / passkey / Google / YouVersion) is enough to connect; publishing your
        <strong> address</strong> is an optional convenience that pre-selects your wallet account and is visible to anyone.
      </div>

      {err ? <div style={cardSty}><b style={{ color: '#b91c1c' }}>Error</b> <span style={{ color: '#64748b' }}>{err}</span></div>
        : !rows ? <p style={{ color: '#64748b' }}>Loading the names you steward…</p>
        : rows.length === 0 ? <p style={{ color: '#64748b' }}>No named agents under your stewardship yet.</p>
        : (
          <div style={{ display: 'grid', gap: '.7rem' }}>
            {rows.map((r) => (
              <div key={r.subjectAgent} style={cardSty}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '.5rem', alignItems: 'center' }}>
                  <div>
                    <strong>{r.name}</strong>
                    <div style={{ ...mono, fontSize: '.74rem', color: '#64748b', marginTop: '.2rem' }}>{shortAddr(r.subjectAgent)}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
                    {r.connectionKind
                      ? <span style={BADGE}>● connect: {r.connectionKind}{r.connectionAddress ? ` · ${shortAddr(r.connectionAddress)}` : ''}</span>
                      : <span style={NEUTRAL}>no connection published</span>}
                    <button style={btnPrimarySty} onClick={() => setEditFor(r)}>{r.connectionKind ? 'Update' : 'Publish connection'}</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

      {editFor && (
        <PublishPanel
          row={editFor}
          via={session?.via ?? 'passkey'}
          name={agentName}
          token={session?.token ?? null}
          onClose={() => setEditFor(null)}
          onDone={() => { setEditFor(null); void load(); }}
        />
      )}
    </SectionShell>
  );
}

/** Publish ceremony: the name's own SA writes its connection record (owner-gated), signed by the steward's
 *  credential, gasless. The address is written ONLY when the explicit "publish address (public)" box is on. */
function PublishPanel({ row, via: viaStr, name, token, onClose, onDone }: {
  row: NameRow; via: string; name: string | null; token: string | null; onClose: () => void; onDone: () => void;
}) {
  const via: Via = viaStr.toLowerCase() === 'wallet' ? 'wallet' : viaStr.toLowerCase() === 'google' ? 'google' : viaStr.toLowerCase() === 'youversion' ? 'youversion' : 'passkey';
  const [kind, setKind] = useState<ConnectionKind>(row.connectionKind ?? viaToKind(viaStr));
  const [publishAddr, setPublishAddr] = useState<boolean>(!!row.connectionAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const addressKind = kind === 'wallet' || kind === 'google' || kind === 'youversion'; // passkey/multi have no pre-select address

  const run = async () => {
    setBusy(true); setError(null);
    try {
      let address: `0x${string}` | undefined;
      if (publishAddr && addressKind) {
        const cred = await resolveCredential(via, name, token);
        if (cred?.kind === 'eoa') address = cred.address;
        else if (publishAddr) { setError('Could not resolve your connection address for this credential.'); setBusy(false); return; }
      }
      const signHash = await signHashFor(via, row.subjectAgent, token ? { token } : undefined);
      const res = await setConnectionInfo(row.subjectAgent, row.name!, kind, signHash, address ? { address } : {});
      if (res.ok) setDone(true);
      else setError(res.error);
    } catch (e) { setError(String((e as Error)?.message ?? e)); }
    finally { setBusy(false); }
  };

  return (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }} onClick={busy ? undefined : onClose}>
      <div style={{ ...cardSty, maxWidth: 540, width: '100%', padding: '1.5rem', boxShadow: '0 24px 60px rgba(15,23,42,.35)' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0, marginBottom: '.6rem' }}>Publish connection for {row.name}</h3>
        {done ? (
          <>
            <p style={{ fontSize: '.9rem', color: '#047857' }}><strong>Published ✓</strong> — {row.name} now advertises how to connect.</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}><button style={btnPrimarySty} onClick={onDone}>Done</button></div>
          </>
        ) : (
          <>
            <p style={{ fontSize: '.86rem', color: '#475569', marginTop: 0 }}>
              Choose the credential a returning person uses to connect to <strong>{row.name}</strong>. This is published
              publicly on the naming service.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem', margin: '.8rem 0' }}>
              {KINDS.map((k) => (
                <button key={k} onClick={() => setKind(k)} style={{ ...(k === kind ? btnPrimarySty : btnSty), padding: '.4rem .7rem' }}>{k}</button>
              ))}
            </div>
            {addressKind && (
              <label style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-start', fontSize: '.82rem', color: '#475569', margin: '.6rem 0' }}>
                <input type="checkbox" checked={publishAddr} onChange={(e) => setPublishAddr(e.target.checked)} style={{ marginTop: '.2rem' }} />
                <span>Also publish my connection <strong>address</strong> to pre-select my account — <strong style={{ color: '#b45309' }}>this is public</strong> (the address is already on-chain; this makes it discoverable by name).</span>
              </label>
            )}
            <p style={{ fontSize: '.8rem', color: '#64748b' }}>
              Your agent writes its own naming record — <code style={mono}>msg.sender == owner</code> — signed by your {via} credential, sponsored. One prompt.
            </p>
            {error && <p style={{ fontSize: '.82rem', color: '#b91c1c', marginTop: '.6rem' }}>{error}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '.6rem', marginTop: '1rem' }}>
              <button style={btnSty} onClick={onClose} disabled={busy}>Cancel</button>
              <button style={btnPrimarySty} onClick={run} disabled={busy}>{busy ? 'Publishing…' : 'Sign & publish'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Nameless → named (spec 257). Claim a public name for the deployed-but-unnamed home, signed by the
 *  member's current credential, gasless — then `onNamed` chains into the publish-connection step. Reuses
 *  the existing `claimName` primitive (which also fires the discovery re-index). */
function ClaimNameCard({ agent, via, token, onNamed }: { agent: Address; via: Via; token: string | null; onNamed: (name: string) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const label = nameLabel(value);

  const claim = async () => {
    if (!label) return;
    setBusy(true); setErr(null);
    try {
      const signHash = await signHashFor(via, agent, token ? { token } : undefined);
      const res = await claimName(agent, signHash, label, (s) => setStep(s));
      if (res.ok) onNamed(res.name);
      else setErr(res.error);
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ ...cardSty, marginBottom: '1.1rem', borderColor: '#c7d2fe' }}>
      <h3 style={{ marginTop: 0, marginBottom: '.4rem' }}>Give your home a public name</h3>
      <p style={{ fontSize: '.85rem', color: '#475569', marginTop: 0 }}>
        Your agent is deployed but <strong>unnamed</strong>. Claim a name so others can find it — and so you can
        re-connect by name on a new device. Your Smart Agent address doesn’t change; the name is a facet pointing at it.
      </p>
      {busy ? (
        <p style={{ color: '#64748b' }}>{step || 'Claiming your name…'}</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder="e.g. rich-pedersen" autoCapitalize="none" spellCheck={false} aria-label="Your public name"
              style={{ flex: 1, minWidth: 180, padding: '.6rem .8rem', borderRadius: 10, border: '1.5px solid #cbd5e1', font: 'inherit' }}
            />
            <button style={btnPrimarySty} onClick={claim} disabled={!label}>Claim name</button>
          </div>
          {label && <p style={{ ...mono, fontSize: '.78rem', color: '#64748b', marginTop: '.4rem' }}>→ {label}.{CONNECT_DOMAIN}</p>}
          {err && <p style={{ fontSize: '.82rem', color: '#b91c1c', marginTop: '.4rem' }}>{err}</p>}
          <p style={{ fontSize: '.78rem', color: '#94a3b8', marginTop: '.5rem' }}>After naming, you can publish an opt-in connection record so you can sign back in by name.</p>
        </>
      )}
    </div>
  );
}
