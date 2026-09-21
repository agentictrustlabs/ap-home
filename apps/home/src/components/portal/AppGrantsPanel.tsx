'use client';
// Spec 397 W4 — CONNECTED ASSISTANTS: the apps this person authorized with their own wire (Claude through the Home MCP,
// above all). Each row says what the wire lets the app do — put a question to your agent as you, and nothing more —
// and REVOKES it on chain: the app's next ask is refused at your agent, in its words, and nothing this Home does can
// bring it back short of you authorizing again.
import { useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import { listAppGrants, forgetAppGrant, type AppGrant } from '../../lib/app-grants';
import { revokeGrantedDelegation } from '../../connect-client';
import { signHashFor, type Via } from '../../home/onboarding';
import { BusyButton } from '../shared/BusyButton';

const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'no expiry');
const WHAT: Record<string, { can: string; cannot: string }> = {
  'ask-as-me': { can: 'Put a question to your agent as you — your records, your organizations, your playbook.', cannot: 'Sign anything: every act still waits for your signature at this Home.' },
};

export function AppGrantsPanel() {
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
  if (grants === null || grants.length === 0) return null;
  const revoke = async (g: AppGrant) => {
    if (!window.confirm(`Revoke ${g.appName}? It takes effect immediately on chain — its next ask is refused at your agent.`)) return;
    setBusy(g.clientId); setErr(null);
    try {
      const signHash = await signHashFor((session.via ?? 'passkey').toLowerCase() as Via, g.delegation.delegator, { token: session.token });
      const r = await revokeGrantedDelegation(g.delegation, signHash);
      if (!r.ok) { setErr(r.error); return; }
      await forgetAppGrant(session.token, g.clientId);
      setGrants((gs) => (gs ?? []).filter((x) => x.clientId !== g.clientId));
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
            <BusyButton className="btn ghost" busy={busy === g.clientId} busyLabel="Revoking on chain…" onClick={() => void revoke(g)} data-testid={`app-grant-revoke-${g.clientId}`}>Revoke</BusyButton>
          </div>
        );
      })}
      {err && <p style={{ color: '#b91c1c', fontSize: '.82rem' }}>{err}</p>}
    </div>
  );
}
