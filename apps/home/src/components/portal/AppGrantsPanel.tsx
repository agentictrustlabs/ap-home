'use client';
// Spec 397 W4 — CONNECTED ASSISTANTS: the apps this person authorized with their own wire (Claude through the Home MCP,
// above all). Each row says what the wire lets the app do — put a question to your agent as you, and nothing more —
// and REVOKES it on chain: the app's next ask is refused at your agent, in its words, and nothing this Home does can
// bring it back short of you authorizing again.
import { useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import { listAppGrants, forgetAppGrant, forgetAppGrantWire, forgetAppConsent, forgetAppPart, forgetSupersededWire, setAskEveryTime, type AppGrant, type AppGrantWire } from '../../lib/app-grants';
import { consentLinesFor } from '../../lib/consent-terms';
import { whitelabel } from '../../whitelabel/config';
import type { DelegationWire } from '../../lib/delegation';
import { actWireWords } from '../../lib/act-as-me';
import { revokeGrantedDelegation } from '../../connect-client';
import { signHashFor, type Via } from '../../home/onboarding';
import { BusyButton } from '../shared/BusyButton';
import { SkeletonRows } from '../../ui';

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
  // STRUCTURE FIRST (owner, 2026-10-02): the heading + a skeleton while the grants read is out, not a blank nothing —
  // so the panel looks complete and does not read as "no assistants" before the read has even answered.
  if (grants === null) return (
    <div style={{ marginTop: '1.5rem' }} data-testid="app-grants">
      <h3 style={{ margin: '0 0 .3rem', fontSize: '.95rem' }}>Connected assistants</h3>
      <SkeletonRows rows={2} />
    </div>
  );
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
    // Spec 445 §7 — every wire this app still holds: the ask and vault wires beside the sign-in, and the older ones.
    const others: DelegationWire[] = [...(g.askDelegation ? [g.askDelegation] : []), ...(g.selfVaultGrant ? [g.selfVaultGrant] : []), ...(g.superseded ?? []).map((s) => s.wire)];
    const count = n + others.length;
    if (!window.confirm(`Revoke ${g.appName}${count ? ` and its ${count} other wire${count === 1 ? '' : 's'}` : ''}? It takes effect immediately on chain — its next ask is refused at your agent.`)) return;
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
      for (const w of others) {
        const r = await revokeGrantedDelegation(w, signHash);
        if (!r.ok) { setErr(r.error); return; }
      }
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
  const change = (clientId: string, f: (g: AppGrant) => AppGrant) => setGrants((gs) => (gs ?? []).map((x) => (x.clientId === clientId ? f(x) : x)));
  /** Spec 445 §7 — one wire of a row: revoked on chain, then forgotten here. The next sign-in shows the sheet. */
  const revokeOne = async (key: string, words: string, wire: DelegationWire, forget: () => Promise<unknown>, after: () => void) => {
    if (!window.confirm(`Revoke ${words}? It takes effect immediately on chain.`)) return;
    setBusy(key); setErr(null);
    try {
      const r = await revokeGrantedDelegation(wire, await signHashFor(via, wire.delegator, { token: session.token }));
      if (!r.ok) { setErr(r.error); return; }
      await forget();
      after();
    } catch (e) { setErr(e instanceof Error ? e.message : 'revoke failed'); }
    finally { setBusy(null); }
  };
  const lineRow = { display: 'flex', gap: '.6rem', alignItems: 'center', justifyContent: 'space-between', padding: '.25rem 0', borderTop: '1px solid var(--line, #e5e7eb)' } as const;
  return (
    <div style={{ marginTop: '1.5rem' }} data-testid="app-grants">
      <h3 style={{ margin: '0 0 .3rem', fontSize: '.95rem' }}>Connected assistants</h3>
      <p className="muted" style={{ margin: '0 0 .6rem', fontSize: '.82rem' }}>
        Apps you let speak to your agent <b>as you</b>. Each holds a wire you signed; revoking it here disables the wire on chain.
      </p>
      {grants.map((g) => {
        const what = WHAT[g.template] ?? { can: `Template ${g.template}.`, cannot: 'Anything the template does not name.' };
        const tpl = whitelabel.delegationTemplates[g.template];
        const agreed = g.terms ? consentLinesFor({ canDo: tpl?.canDo ?? [what.can], cannotDo: tpl?.cannotDo ?? [what.cannot] }, g.terms) : null;
        return (
          <div key={g.clientId} className="connected-app-card" data-testid={`app-grant-${g.clientId}`}>
            <div className="connected-app-head">
              <div className="connected-app-logo placeholder" aria-hidden="true">{g.appName.slice(0, 1).toUpperCase()}</div>
              <div>
                <div className="connected-app-name">{g.appName}</div>
                <div className="connected-app-domain">since {fmt(g.issuedAt)} · until {fmt(g.validUntil)}{g.lastUsedAt ? ` · last signed in ${fmt(g.lastUsedAt)}` : ''}</div>
              </div>
            </div>
            {agreed ? (
              <>
                <ul className="consent-list can">{agreed.canDo.map((l) => <li key={l}>{l}</li>)}</ul>
                <ul className="consent-list cannot">{agreed.cannotDo.map((l) => <li key={l}>{l}</li>)}</ul>
              </>
            ) : (
              <>
                <ul className="consent-list can"><li>{what.can}</li></ul>
                <ul className="consent-list cannot"><li>{what.cannot}</li></ul>
              </>
            )}
            {(g.askDelegation || g.selfVaultGrant || (g.superseded ?? []).length > 0) && (
              <ul style={{ listStyle: 'none', padding: 0, margin: '.4rem 0' }} data-testid={`app-grant-others-${g.clientId}`}>
                {g.askDelegation && (
                  <li style={lineRow}><span style={{ fontSize: '.85rem' }}>Ask your agent as you <span className="muted">· until {fmt(g.ask?.validUntil ?? null)}</span></span>
                    <BusyButton className="btn ghost" busy={busy === `${g.clientId}:ask`} busyLabel="Revoking…" onClick={() => void revokeOne(`${g.clientId}:ask`, 'this wire', g.askDelegation!, () => forgetAppPart(session.token, g.clientId, 'ask'), () => change(g.clientId, ({ askDelegation: _a, ...x }) => x))}>Revoke</BusyButton></li>
                )}
                {g.selfVaultGrant && (
                  <li style={lineRow}><span style={{ fontSize: '.85rem' }}>Keep its records in your vault <span className="muted">· until {fmt(g.vault?.validUntil ?? null)}</span></span>
                    <BusyButton className="btn ghost" busy={busy === `${g.clientId}:vault`} busyLabel="Revoking…" onClick={() => void revokeOne(`${g.clientId}:vault`, 'this wire', g.selfVaultGrant!, () => forgetAppPart(session.token, g.clientId, 'vault'), () => change(g.clientId, ({ selfVaultGrant: _v, ...x }) => x))}>Revoke</BusyButton></li>
                )}
                {(g.superseded ?? []).map((s) => (
                  <li key={s.ref} style={lineRow} data-testid={`app-grant-superseded-${s.ref}`}><span style={{ fontSize: '.85rem' }}>An older permission, still live <span className="muted">· until {fmt(s.validUntil)}</span></span>
                    <BusyButton className="btn ghost" busy={busy === s.ref} busyLabel="Revoking…" onClick={() => void revokeOne(s.ref, 'this older permission', s.wire, () => forgetSupersededWire(session.token, g.clientId, s.ref), () => change(g.clientId, (x) => ({ ...x, superseded: (x.superseded ?? []).filter((y) => y.ref !== s.ref) })))}>Revoke</BusyButton></li>
                ))}
              </ul>
            )}
            {g.terms && (
              <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap', margin: '.4rem 0', fontSize: '.85rem' }}>
                <label><input type="checkbox" checked={!!g.askEveryTime} data-testid={`app-grant-ask-every-time-${g.clientId}`} onChange={(e) => {
                  const on = e.target.checked;
                  const apply = (v: boolean) => change(g.clientId, ({ askEveryTime: _a, ...x }) => (v ? { ...x, askEveryTime: true as const } : x));
                  apply(on); // at once: a checkbox that waits for the server looks as if the click did nothing
                  void setAskEveryTime(session.token, g.clientId, on).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); }).catch((err: unknown) => { apply(!on); setErr(`Could not save that: ${err instanceof Error ? err.message : 'the request failed'}`); });
                }} /> Ask me every time</label>
                <button type="button" className="btn ghost" data-testid={`app-grant-forget-${g.clientId}`} onClick={() => void forgetAppConsent(session.token, g.clientId).then(() => change(g.clientId, ({ terms: _t, ...x }) => x))}>Forget this app</button>
              </div>
            )}
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
