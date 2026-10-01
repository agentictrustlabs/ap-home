'use client';
// Spec 397 W4 — CONNECTED ASSISTANTS: the apps this person authorized with their own wire (Claude through the Home MCP,
// above all). Each row says what the wire lets the app do — put a question to your agent as you, and nothing more —
// and REVOKES it on chain: the app's next ask is refused at your agent, in its words, and nothing this Home does can
// bring it back short of you authorizing again.
import { useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import { listAppGrants, forgetAppGrant, forgetAppGrantWire, type AppGrant, type AppGrantWire } from '../../lib/app-grants';
import { actWireWords } from '../../lib/act-as-me';
import { revokeGrantedDelegation } from '../../connect-client';
import { signHashFor, type Via } from '../../home/onboarding';
import { BusyButton } from '../shared/BusyButton';

const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'no expiry');
const WHAT: Record<string, { can: string; cannot: string }> = {
  'ask-as-me': { can: 'Put a question to your agent as you — your records, your organizations, your playbook.', cannot: 'Sign anything: every act still waits for your signature at this Home.' },
  // Spec 397 §11 — the act rows are listed APART from the ask line: each wire is one act, revocable on its own.
  'act-as-me': { can: 'Ask your agent as you, and run the acts listed below without a second signature until each wire expires.', cannot: 'Run any act not listed below; pay anyone but the named payee, or more than the cap — those still wait for your signature.' },
};

export function AppGrantsPanel({ showEmpty = false }: { showEmpty?: boolean } = {}) {
  const { session, agentAddress } = useSession();
  const [grants, setGrants] = useState<AppGrant[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!session?.token) return;
    void listAppGrants(session.token)
      .then(setGrants)
      .catch((e: unknown) => { setGrants(null); setErr(`Connected assistants could not be read: ${e instanceof Error ? e.message : 'the listing failed'}`); });
  }, [session?.token]);
  if (!session || !agentAddress) return null;
  if (grants === null && err) {
    // The read failed: say so where the list would be — an empty panel would read as "none" (398 §6.3).
    return (
      <div style={{ marginTop: '1.5rem' }} data-testid="app-grants">
        <h3 style={{ margin: '0 0 .3rem', fontSize: '.95rem' }}>Connected assistants</h3>
        <p className="error" data-testid="app-grants-failed" style={{ fontSize: '.82rem' }}>{err}</p>
      </div>
    );
  }
  if (grants === null) return null;
  if (grants.length === 0) {
    if (!showEmpty) return null;
    return (
      <div className="ui-empty" data-testid="app-grants-empty">
        <span className="ui-empty-title">No assistant is connected</span>
        <span>Connect one from the assistant's side (Claude: add this Home as a connector) — it appears here with what it may do, and a button that stops it.</span>
      </div>
    );
  }
  const via = (session.via ?? 'passkey').toLowerCase() as Via;
  const revoke = async (g: AppGrant) => {
    const n = g.wires?.length ?? 0;
    if (!window.confirm(`Revoke ${g.appName}${n ? ` and its ${n} act wire${n === 1 ? '' : 's'}` : ''}? It takes effect immediately on chain — its next ask is refused at your agent.`)) return;
    setBusy(g.clientId); setErr(null);
    try {
      // Spec 397 §11 — THE SET: every act wire first (each its own delegator — a payment wire is the treasury's), then
      // the ask wire. A wire that fails stops here and is said; what was revoked stays revoked.
      for (const w of g.wires ?? []) {
        const r = await revokeGrantedDelegation(w.wire, await signHashFor(via, w.wire.delegator, { token: session.token }));
        if (!r.ok) { setErr(`${actWireWords(w)}: ${r.error}`); return; }
        await forgetAppGrantWire(session.token, g.clientId, w.ref);
      }
      const signHash = await signHashFor(via, g.delegation.delegator, { token: session.token });
      const r = await revokeGrantedDelegation(g.delegation, signHash);
      if (!r.ok) { setErr(r.error); return; }
      await forgetAppGrant(session.token, g.clientId);
      setGrants((gs) => (gs ?? []).filter((x) => x.clientId !== g.clientId));
    } catch (e) { setErr(e instanceof Error ? e.message : 'revoke failed'); }
    finally { setBusy(null); }
  };
  /** Spec 397 §11 — ONE act wire: revoked on chain under its own delegator, forgotten here; the ask line and the other wires stand. */
  const revokeWire = async (g: AppGrant, w: AppGrantWire) => {
    if (!window.confirm(`Revoke this wire (${actWireWords(w)})? ${g.appName} keeps asking as you; this act goes back to waiting for your signature.`)) return;
    setBusy(w.ref); setErr(null);
    try {
      const r = await revokeGrantedDelegation(w.wire, await signHashFor(via, w.wire.delegator, { token: session.token }));
      if (!r.ok) { setErr(r.error); return; }
      await forgetAppGrantWire(session.token, g.clientId, w.ref);
      setGrants((gs) => (gs ?? []).map((x) => (x.clientId === g.clientId ? { ...x, wires: (x.wires ?? []).filter((y) => y.ref !== w.ref) } : x)));
    } catch (e) { setErr(e instanceof Error ? e.message : 'revoke failed'); }
    finally { setBusy(null); }
  };
  return (
    <div style={{ marginTop: '1.5rem' }} data-testid="app-grants">
      <h3 style={{ margin: '0 0 .3rem', fontSize: '.95rem' }}>Connected assistants</h3>
      <p className="muted" style={{ margin: '0 0 .6rem', fontSize: '.82rem' }}>
        Apps you let speak to your agent <b>as you</b>. Each holds a wire you signed; revoking it here disables the wire on chain.
      </p>
      {grants.map((g) => {
        const what = WHAT[g.template] ?? { can: `Template ${g.template}.`, cannot: 'Anything the template does not name.' };
        return (
          <div key={g.clientId} className="connected-app-card" data-testid={`app-grant-${g.clientId}`}>
            <div className="connected-app-head">
              <div className="connected-app-logo placeholder" aria-hidden="true">{g.appName.slice(0, 1).toUpperCase()}</div>
              <div>
                <div className="connected-app-name">{g.appName}</div>
                <div className="connected-app-domain">since {fmt(g.issuedAt)} · until {fmt(g.validUntil)}</div>
              </div>
            </div>
            <ul className="consent-list can"><li>{what.can}</li></ul>
            <ul className="consent-list cannot"><li>{what.cannot}</li></ul>
            {g.template === 'act-as-me' && (
              <div className="app-grant-acts" data-testid={`app-grant-acts-${g.clientId}`}>
                <p className="muted" style={{ margin: '.4rem 0 .3rem', fontSize: '.82rem' }}><b>Acts it may run without asking you</b> — one wire each:</p>
                {(g.wires ?? []).length === 0 && <p className="muted" style={{ fontSize: '.82rem' }}>none left — every act waits for your signature again</p>}
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {(g.wires ?? []).map((w) => (
                    <li key={w.ref} data-testid={`app-grant-wire-${w.capability}`} style={{ display: 'flex', gap: '.6rem', alignItems: 'center', justifyContent: 'space-between', padding: '.25rem 0', borderTop: '1px solid var(--line, #e5e7eb)' }}>
                      <span style={{ fontSize: '.85rem' }}><b>{w.capability}</b>{w.capability === 'treasury.payment.execute' ? <> — {actWireWords(w)}</> : null} <span className="muted">· until {fmt(w.validUntil)}</span></span>
                      <BusyButton className="btn ghost" busy={busy === w.ref} busyLabel="Revoking…" onClick={() => void revokeWire(g, w)} data-testid={`app-grant-wire-revoke-${w.capability}`}>Revoke this act</BusyButton>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <BusyButton className="btn ghost" busy={busy === g.clientId} busyLabel="Revoking on chain…" onClick={() => void revoke(g)} data-testid={`app-grant-revoke-${g.clientId}`}>{g.template === 'act-as-me' ? 'Revoke everything' : 'Revoke'}</BusyButton>
          </div>
        );
      })}
      {err && <p style={{ color: '#b91c1c', fontSize: '.82rem' }}>{err}</p>}
    </div>
  );
}
