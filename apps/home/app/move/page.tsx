'use client';
// MOVE YOUR HOME HERE — spec 410 §1.2 step 5. The person's agent stays exactly what it is (its address never changes,
// ADR-0010); what moves is the CREDENTIAL that custodies it — a passkey scoped to this Home's domain — and, with it,
// every standing wire she issued, re-approved in the one signature she gives at her OLD Home. Three steps, in the
// order the trust runs: create the passkey here (a public key; nothing secret leaves this device) → carry its
// ticket to the old Home and sign the move there → come back and sign in. Never a recovery: nothing was lost.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Address } from '@agenticprimitives/types';
import { mintMoveTicket, pendingMove, forgetPendingMove, claimMovedPasskey, type MoveTicketV1 } from '../../src/home/move';

const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

export default function MoveHomeHerePage() {
  const [who, setWho] = useState('');
  const [agent, setAgent] = useState<Address | null>(null);
  const [minted, setMinted] = useState<{ ticket: MoveTicketV1; encoded: string } | null>(null);
  const [pending, setPending] = useState<ReturnType<typeof pendingMove>>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);

  useEffect(() => { setPending(pendingMove()); }, []);

  const resolve = async () => {
    setNote(null);
    const w = who.trim();
    if (isAddress(w)) { setAgent(w.toLowerCase() as Address); return; }
    setBusy(true);
    try {
      const info = (await (await fetch(`/connect/name-info?name=${encodeURIComponent(w)}`)).json().catch(() => ({}))) as { agent?: Address | null; exists?: boolean };
      if (!info.agent) { setNote(`no agent is named ${w} on this estate — give the address instead`); return; }
      setAgent(info.agent.toLowerCase() as Address);
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const mint = async () => {
    if (!agent) return;
    setBusy(true); setNote(null);
    try {
      const out = await mintMoveTicket(agent, `Home passkey (${window.location.hostname}, ${new Date().toISOString().slice(0, 10)})`);
      setMinted({ ticket: out.ticket, encoded: out.encoded });
      setPending(pendingMove());
    } catch (e) { setNote(e instanceof Error ? e.message : 'the passkey could not be created on this device'); } finally { setBusy(false); }
  };
  const claim = async () => {
    const p = pending; if (!p) return;
    setBusy(true); setNote(null);
    try {
      const r = await claimMovedPasskey(p.agent, p.credentialIdDigest);
      if (r.ok) { setClaimed(true); forgetPendingMove(); setNote('This Home now knows your passkey. Sign in with it.'); }
      else setNote(r.notYet ? 'The chain does not hold this passkey yet — finish the move at your old Home (one signature there), then try again.' : r.error);
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '2rem 1rem' }}>
      <h1>Move your Home here</h1>
      <p className="muted">Your agent stays what it is — same address, same name, same grants. What moves is the passkey that custodies it: one created on this device, for this Home, added by one signature at your old Home. Nothing secret leaves this device, and nothing was lost — this is not a recovery.</p>

      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem' }}>1 · Create a passkey here</h2>
        {!minted ? (
          <div>
            <label style={{ display: 'block', fontSize: '.9rem' }}>Your agent (its name or address)
              <input className="onboarding-input" value={who} onChange={(e) => { setWho(e.target.value); setAgent(null); }} placeholder="alice.impact or 0x…" />
            </label>
            {!agent ? (
              <button className="btn-primary" style={{ width: 'auto', marginTop: '.5rem' }} disabled={busy || !who.trim()} onClick={() => void resolve()}>{busy ? 'looking…' : 'Find my agent'}</button>
            ) : (
              <p style={{ fontSize: '.9rem' }}>Moving <code>{agent}</code>. <button className="btn-primary" style={{ width: 'auto' }} disabled={busy} onClick={() => void mint()}>{busy ? 'creating…' : 'Create the passkey on this device'}</button></p>
            )}
          </div>
        ) : (
          <div>
            <p className="onboarding-hint ok">✓ Passkey created for {minted.ticket.home}. Its public key is in the ticket below.</p>
            <h2 style={{ fontSize: '1rem', marginTop: '1rem' }}>2 · Sign the move at your old Home</h2>
            <p style={{ fontSize: '.9rem' }}>At your old Home, open <b>Security → Move to another Home</b> and paste this ticket. One signature there adds this passkey, retires the old one and re-approves everything you granted.</p>
            <textarea readOnly rows={4} value={minted.encoded} style={{ width: '100%', fontFamily: 'monospace', fontSize: '.75rem' }} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn-ghost onboarding-secondary" style={{ marginTop: '.4rem' }} onClick={() => { void navigator.clipboard?.writeText(minted.encoded).then(() => setNote('Ticket copied.')).catch(() => setNote('Select the ticket and copy it.')); }}>Copy the ticket</button>
          </div>
        )}
      </section>

      {(pending || minted) && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem' }}>3 · Come back and sign in</h2>
          <p style={{ fontSize: '.9rem' }}>Once the old Home has signed, this Home checks the chain holds your new passkey and indexes it for sign-in. It refuses until the chain says so.</p>
          {!claimed ? (
            <button className="btn-primary" style={{ width: 'auto' }} disabled={busy} onClick={() => void claim()}>{busy ? 'checking the chain…' : 'I signed at my old Home — check now'}</button>
          ) : (
            <p className="onboarding-hint ok">✓ Ready. <Link href="/">Sign in with your passkey</Link>. Your records follow separately (your Home carries them under your own grant).</p>
          )}
        </section>
      )}
      {note && <p className="muted" style={{ marginTop: '.75rem', fontSize: '.9rem' }}>{note}</p>}
    </main>
  );
}
