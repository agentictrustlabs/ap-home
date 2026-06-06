'use client';
// Spec 265 W4 — the person's OWN YouVersion data, read on demand through Connect (which uses the
// KMS-custodied token server-side and returns only the data; the token never reaches the browser). This
// proves the full chain end-to-end: sign in with YouVersion → token custodied → read highlights back.
// notes/bookmarks/saved verses light up once their OAuth scopes are confirmed in the Platform Portal.
import { useState } from 'react';
import { useSession } from '../../context/session';

type Phase = 'idle' | 'loading' | 'done' | 'error';

export function YouVersionData() {
  const { session } = useSession();
  const [phase, setPhase] = useState<Phase>('idle');
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [err, setErr] = useState('');

  async function load() {
    if (!session?.token) return;
    setPhase('loading');
    setErr('');
    try {
      const r = await fetch('/connect/youversion?type=highlights', { headers: { authorization: `Bearer ${session.token}` } });
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

      {phase === 'idle' && (
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
