'use client';
// Spec 265 W4 — the person's OWN YouVersion data, read on demand through Connect (which uses the
// KMS-custodied token server-side and returns only the data; the token never reaches the browser). This
// proves the full chain end-to-end: sign in with YouVersion → token custodied → read highlights back.
// YouVersion serves highlights one Bible chapter at a time (there is no "all highlights" endpoint), so the
// reader picks a chapter. Highlights are YouVersion's only personal-data resource (no notes/bookmarks API).
import { useEffect, useState } from 'react';
import { useSession } from '../../context/session';

type Phase = 'idle' | 'loading' | 'done' | 'error';

export function YouVersionData() {
  const { session } = useSession();
  const [phase, setPhase] = useState<Phase>('idle');
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [err, setErr] = useState('');
  const [chapter, setChapter] = useState('JHN.3');
  const [granting, setGranting] = useState(false);
  const [notice, setNotice] = useState<'granted' | 'cancelled' | 'error' | ''>('');

  // On return from YouVersion's Data Exchange approval page, the callback lands us at /apps?yv_highlights=…
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const r = p.get('yv_highlights');
    if (r === 'granted' || r === 'cancelled' || r === 'error') {
      setNotice(r);
      p.delete('yv_highlights');
      const qs = p.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
  }, []);

  // Highlights are gated behind YouVersion's separate Data Exchange consent — kick off the approval flow.
  async function grantAccess() {
    if (!session?.token) return;
    setGranting(true);
    setErr('');
    try {
      const r = await fetch('/connect/youversion/data-exchange', { headers: { authorization: `Bearer ${session.token}` } });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; approveUrl?: string; error?: string; detail?: unknown };
      if (!r.ok || !j.ok || !j.approveUrl) {
        const detail = j.detail ? ` — ${typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)}` : '';
        setErr(`${j.error ?? `Couldn't start highlights approval (HTTP ${r.status})`}${detail}`);
        setGranting(false);
        return;
      }
      window.location.href = j.approveUrl; // YouVersion approval page → back to /apps?yv_highlights=…
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setGranting(false);
    }
  }

  async function load() {
    if (!session?.token) return;
    setPhase('loading');
    setErr('');
    try {
      const passage = encodeURIComponent(chapter.trim() || 'JHN.3');
      const r = await fetch(`/connect/youversion?type=highlights&passage=${passage}`, { headers: { authorization: `Bearer ${session.token}` } });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; data?: unknown; error?: string; detail?: unknown };
      if (!r.ok || j.ok === false) {
        const detail = j.detail ? ` — ${typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)}` : '';
        setErr(
          j.error === 'no_youversion_link'
            ? 'No YouVersion account linked yet — sign in with YouVersion first.'
            : `${j.error ?? `Couldn't load (HTTP ${r.status})`}${detail}`,
        );
        setPhase('error');
        return;
      }
      const d = j.data as { highlights?: unknown[]; data?: unknown[] } | unknown[] | null;
      const list = (Array.isArray(d) ? d : d?.highlights ?? d?.data ?? []) as Array<Record<string, unknown>>;
      setItems(list);
      setPhase('done');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }

  return (
    <div className="connected-app-card">
      <div className="connected-app-head">
        <div className="connected-app-logo placeholder" aria-hidden="true">Y</div>
        <div>
          <div className="connected-app-name">Your YouVersion highlights</div>
          <div className="connected-app-domain">read live from YouVersion · your token stays in your home</div>
        </div>
      </div>

      {notice === 'granted' && <p className="onboarding-hint">Highlights access approved — pick a chapter and show your highlights.</p>}
      {notice === 'cancelled' && <p className="onboarding-hint taken">Highlights approval was cancelled.</p>}
      {notice === 'error' && <p className="onboarding-hint taken">Highlights approval didn’t complete — try again.</p>}

      <p className="muted footnote" style={{ margin: '0 0 .6rem' }}>
        YouVersion requires a one-time approval before sharing highlights. Approve it once, then read any chapter.
      </p>
      <button className="btn-ghost onboarding-secondary" onClick={grantAccess} disabled={granting || !session?.token} style={{ marginBottom: '.6rem' }}>
        {granting ? 'Opening YouVersion…' : 'Grant highlights access'}
      </button>

      <label style={{ display: 'flex', gap: '.5rem', alignItems: 'center', fontSize: '.85rem', margin: '.4rem 0 .6rem' }}>
        <span className="muted">Chapter</span>
        <input
          value={chapter}
          onChange={(e) => setChapter(e.target.value)}
          placeholder="JHN.3"
          spellCheck={false}
          style={{ flex: 1, padding: '.4rem .55rem', border: '1px solid var(--border, #d7dce5)', borderRadius: 6, fontSize: '.85rem' }}
        />
      </label>

      {(phase === 'idle' || phase === 'done') && (
        <button className="btn-primary" onClick={load} disabled={!session?.token}>Show my highlights</button>
      )}
      {phase === 'loading' && (
        <div className="onboarding-busy"><span className="spinner" role="status" aria-label="Loading" /><span className="onboarding-busy-msg">Reading from YouVersion…</span></div>
      )}
      {phase === 'error' && (
        <>
          <p className="onboarding-hint taken">{err}</p>
          <button className="btn-ghost onboarding-secondary" onClick={load}>Try again</button>
        </>
      )}
      {phase === 'done' && (
        items.length === 0 ? (
          <p className="muted footnote">No highlights found in your YouVersion account.</p>
        ) : (
          <ul className="consent-list can">
            {items.slice(0, 25).map((h, i) => (
              <li key={(h.id as string) ?? i}>
                {(h.reference as string) ?? (h.passage_id as string) ?? (h.usfm as string) ?? JSON.stringify(h)}
                {h.color ? <span className="muted"> · {String(h.color)}</span> : null}
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
