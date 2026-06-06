'use client';
// Spec 265 W4 — the consent control: which YouVersion data types the person grants THIS connected app to
// read. Writes the authoritative VaultGrant via Connect (POST /connect/youversion → demo-a2a set-grant),
// and mirrors the selection into the local connected-apps record for the checked state. Only the granted
// scopes' MCP read routes will succeed for this app.
import { useState } from 'react';
import { useSession } from '../../context/session';
import { recordConnectedApp } from '../../lib/connected-apps';
import type { Permission } from '../../home/types';

const SCOPES: Array<{ id: string; label: string; live: boolean }> = [
  { id: 'highlights', label: 'Highlights', live: true },
  { id: 'notes', label: 'Notes', live: false },
  { id: 'bookmarks', label: 'Bookmarks', live: false },
  { id: 'saved_verses', label: 'Saved verses', live: false },
];

type Phase = 'idle' | 'saving' | 'saved' | 'error';

export function YouVersionScopePicker({ app }: { app: Permission }) {
  const { session, agentAddress } = useSession();
  const [sel, setSel] = useState<Set<string>>(new Set(app.youversionScopes ?? []));
  const [phase, setPhase] = useState<Phase>('idle');
  const [err, setErr] = useState('');

  const toggle = (id: string) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id); else n.add(id);
    setSel(n);
    setPhase('idle');
  };

  async function save() {
    if (!session?.token) return;
    setPhase('saving');
    setErr('');
    try {
      const scopes = [...sel];
      const r = await fetch('/connect/youversion', {
        method: 'POST',
        headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: app.clientId, scopes }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || j.ok === false) { setErr(j.error ?? `HTTP ${r.status}`); setPhase('error'); return; }
      if (agentAddress) recordConnectedApp(agentAddress, { ...app, youversionScopes: scopes });
      setPhase('saved');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }

  return (
    <div className="yv-scopes">
      <div className="yv-scopes-title">YouVersion data {app.appName} can read</div>
      <div className="yv-scopes-list">
        {SCOPES.map((s) => (
          <label key={s.id} className="yv-scope">
            <input type="checkbox" checked={sel.has(s.id)} onChange={() => toggle(s.id)} />
            <span>{s.label}{!s.live && <span className="muted"> · soon</span>}</span>
          </label>
        ))}
      </div>
      <button className="btn-ghost onboarding-secondary" onClick={save} disabled={phase === 'saving' || !session?.token}>
        {phase === 'saving' ? 'Saving…' : phase === 'saved' ? 'Saved ✓' : 'Save access'}
      </button>
      {phase === 'error' && <p className="onboarding-hint taken">{err}</p>}
    </div>
  );
}
