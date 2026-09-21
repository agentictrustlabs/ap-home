'use client';
// THE DISPUTE ON THE RECEIPT — spec 410 §10.2 item 3 (spec 406's operator view). Under a run: whether a dispute cites
// it; the exchanges so far, each signed by its author; and the one thing THIS person may do next — open one (the
// person whose run it is), answer (the counterparty), or determine (a steward the public record names, saying which
// subject they act under). A determination closes the dispute and reverses nothing: a reversal is a new act.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { signHashFor, resolveVia, type Via } from '../../../home/onboarding';
import { openDisputeFromHome, appendDisputeFromHome, readDisputeFor, type DisputeInteractionV1, type DisputeRole } from '../../../home/dispute';

const short = (v: string, n = 12): string => (v.length > n ? `${v.slice(0, n - 4)}…${v.slice(-3)}` : v);

export function DisputePanel({ token, addressee, runRef, counterparty, stepRef }: { token: string; addressee: Address; runRef: string; /** whom the receipt names on the other side (the acting agent, or the org the act was routed to) */ counterparty?: Address; stepRef?: string }) {
  const { session, agentAddress, profile } = useSession();
  const me = (agentAddress ?? '').toLowerCase() as Address;
  const [ix, setIx] = useState<DisputeInteractionV1 | null | 'loading'>('loading');
  const [words, setWords] = useState('');
  const [under, setUnder] = useState('https://agenticprimitives.dev/ns/org#');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    void readDisputeFor(me, runRef).then((d) => { if (!cancelled) setIx(d); }).catch(() => { if (!cancelled) setIx(null); });
    return () => { cancelled = true; };
  }, [me, runRef]);

  const signer = useCallback(async () => signHashFor(resolveVia(profile?.credential as string | undefined, session?.via) as Via, me, { token }), [me, profile?.credential, session?.via, token]);

  const open = async () => {
    if (!words.trim() || !counterparty) return;
    setBusy(true); setNote(null);
    try {
      const sign = await signer();
      const out = await openDisputeFromHome({ session: { token }, me, receipt: { agent: addressee, runRef, ...(stepRef ? { stepRef } : {}) }, counterparty, words, sign });
      if (!out.ok) { setNote(out.error); return; }
      setIx(out.interaction); setWords('');
      setNote(out.told?.ok ? 'Opened, and the other party was told.' : `Opened; the other party was not told${out.told?.error ? ` (${out.told.error})` : ''} — they hold a copy in their vault.`);
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const append = async (role: DisputeRole, performative: 'INFORM' | 'ISSUE' | 'REJECT') => {
    if (!words.trim() || !ix || ix === 'loading') return;
    setBusy(true); setNote(null);
    try {
      const sign = await signer();
      const out = await appendDisputeFromHome({ session: { token }, me, interaction: ix, role, performative, words, ...(role === 'steward' ? { under } : {}), sign });
      if (!out.ok) { setNote(out.error); return; }
      setIx(out.interaction); setWords('');
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  if (ix === 'loading' || !me) return null;
  const myRole: DisputeRole | null = ix ? (me === ix.parties.disputant ? 'disputant' : me === ix.parties.counterparty ? 'counterparty' : 'steward') : null;
  return (
    <div className="muted" style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.55 }} data-testid="run-dispute">
      {!ix ? (
        counterparty && counterparty.toLowerCase() !== me ? (
          <details>
            <summary style={{ cursor: 'pointer' }}>dispute this receipt</summary>
            <div style={{ marginTop: 4 }}>
              <textarea value={words} onChange={(e) => setWords(e.target.value)} placeholder="What is wrong with this receipt, in your words" rows={2} style={{ width: '100%', fontSize: 11.5 }} />
              <button type="button" className="btn ghost" style={{ fontSize: 10.5, padding: '0 6px', minHeight: 0 }} disabled={busy || !words.trim()} onClick={() => void open()}>{busy ? 'signing…' : `open a dispute with ${short(counterparty)} (you sign)`}</button>
              <span> · a dispute is evidence, not a reversal; a steward the public record names determines it</span>
            </div>
          </details>
        ) : null
      ) : (
        <div>
          <strong>disputed</strong> · {short(ix.id, 16)} · {ix.closed ? `closed: ${ix.closed.reason} by ${short(ix.closed.by)} at ${ix.closed.at}` : 'open'} · under {ix.profileVersion}
          {ix.exchanges.map((x) => (
            <div key={x.digest} style={{ paddingLeft: 10 }}>
              <span style={{ opacity: 0.7 }}>{x.seq} · {x.role} {short(x.author)} · {x.performative}{x.under ? ` under ${x.under}` : ''} · signed {short(x.signature, 10)}</span>
              <div>“{x.words}”</div>
            </div>
          ))}
          {!ix.closed && myRole && (
            <div style={{ marginTop: 4 }}>
              <textarea value={words} onChange={(e) => setWords(e.target.value)} placeholder={myRole === 'steward' ? 'Your determination, in your words' : 'Your answer, in your words'} rows={2} style={{ width: '100%', fontSize: 11.5 }} />
              {myRole === 'steward' && <input value={under} onChange={(e) => setUnder(e.target.value)} placeholder="the subject IRI the registry names you steward of" style={{ width: '100%', fontSize: 11.5 }} />}
              {myRole === 'disputant' && <button type="button" className="btn ghost" style={{ fontSize: 10.5, padding: '0 6px', minHeight: 0 }} disabled={busy || !words.trim()} onClick={() => void append('disputant', 'INFORM')}>add to the dispute (you sign)</button>}
              {myRole === 'counterparty' && <button type="button" className="btn ghost" style={{ fontSize: 10.5, padding: '0 6px', minHeight: 0 }} disabled={busy || !words.trim()} onClick={() => void append('counterparty', 'INFORM')}>answer (you sign)</button>}
              {myRole === 'steward' && <>
                <button type="button" className="btn ghost" style={{ fontSize: 10.5, padding: '0 6px', minHeight: 0 }} disabled={busy || !words.trim()} onClick={() => void append('steward', 'ISSUE')}>record a determination (you sign)</button>
                {' '}<button type="button" className="btn ghost" style={{ fontSize: 10.5, padding: '0 6px', minHeight: 0 }} disabled={busy || !words.trim()} onClick={() => void append('steward', 'REJECT')}>decline to determine</button>
              </>}
            </div>
          )}
        </div>
      )}
      {note && <div style={{ marginTop: 2 }}>{note}</div>}
    </div>
  );
}
