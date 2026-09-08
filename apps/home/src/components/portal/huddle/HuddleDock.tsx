'use client';
// THE DOCK — spec 378 §1. Small, persistent, above the routed content. Who is here, who is speaking, the
// mic, the screen, leave — and end for whoever may. It shows the human AND the principal they represent.
import React, { useEffect, useState } from 'react';
import { useRealtimeKitSelector, RealtimeKitProvider } from '@cloudflare/realtimekit-react';
import { useHuddle } from './HuddleProvider';

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

function Participants() {
  const joined = useRealtimeKitSelector((m) => m.participants.joined.toArray());
  const active = useRealtimeKitSelector((m) => m.participants.active.toArray());
  const self = useRealtimeKitSelector((m) => ({ name: m.self.name, audioEnabled: m.self.audioEnabled }));
  const speaking = new Set(active.map((p) => p.id));
  return (
    <div className="huddle-avatars" aria-label="Participants">
      <span className={`huddle-avatar self${self.audioEnabled ? ' speaking' : ''}`} title={`${self.name} (you)`}>{(self.name || '?').slice(0, 1).toUpperCase()}</span>
      {joined.map((p) => (
        <span key={p.id} className={`huddle-avatar${speaking.has(p.id) ? ' speaking' : ''}`} title={p.name}>{(p.name || '?').slice(0, 1).toUpperCase()}</span>
      ))}
    </div>
  );
}

export function HuddleDock({ nameOf }: { nameOf?: (address: string) => string | undefined }) {
  const h = useHuddle();
  const [open, setOpen] = useState(false);
  const label = (a: string) => nameOf?.(a) ?? short(a);
  if (!h.current || !h.meeting) return h.error ? <div className="huddle-dock huddle-dock-error" role="status">{h.error} <button className="huddle-link" onClick={h.dismissError}>dismiss</button></div> : null;
  const c = h.current;
  const canEnd = c.role === 'host';
  return (
    <RealtimeKitProvider value={h.meeting}>
      <div className={`huddle-dock${open ? ' open' : ''}`} role="region" aria-label="Huddle">
        <div className="huddle-dock-row">
          <button className="huddle-title" onClick={() => setOpen((o) => !o)} title="Expand">
            <span className="huddle-live" aria-hidden />
            <span>Huddle · {c.scopeName}</span>
            {c.represented && <span className="huddle-as">as {label(c.represented)}</span>}
          </button>
          <Participants />
          <div className="huddle-controls">
            <button className={`huddle-btn${h.micOn ? ' on' : ''}`} onClick={() => void h.toggleMic()} aria-pressed={h.micOn} title={h.micOn ? 'Mute' : 'Unmute'}>{h.micOn ? '🎙' : '🔇'}</button>
            <button className={`huddle-btn${h.screenOn ? ' on' : ''}`} onClick={() => void h.toggleScreen()} aria-pressed={h.screenOn} title={h.screenOn ? 'Stop sharing' : 'Share screen'}>🖥</button>
            <button className="huddle-btn leave" onClick={() => void h.leave()} disabled={!!h.busy} title="Leave">Leave</button>
            {canEnd && <button className="huddle-btn end" onClick={() => { if (confirm('End this huddle for everyone?')) void h.end(); }} disabled={!!h.busy} title="End for everyone">End</button>}
          </div>
        </div>
        {open && (
          <div className="huddle-panel">
            <div className="huddle-panel-list">
              {c.run.roster.map((r) => (
                <div key={r.actor} className="huddle-panel-row">
                  <span>{label(r.actor)}{r.represented ? ` · as ${label(r.represented)}` : ''}</span>
                  <span className="huddle-role">{r.role}{r.joined ? '' : ' · not joined'}</span>
                </div>
              ))}
            </div>
            {h.error && <div className="huddle-dock-error">{h.error} <button className="huddle-link" onClick={h.dismissError}>dismiss</button></div>}
            <div className="huddle-panel-note">Audio and your screen go straight to the call. Who may be here was decided by this {c.scope.kind === 'org' || c.scope.kind === 'topic' ? 'organization' : c.scope.kind}'s own records, not by this screen.</div>
          </div>
        )}
      </div>
    </RealtimeKitProvider>
  );
}

/** The affordance on a context: start, or join the one already running. */
export function HuddleAffordance({ scope, scopeName, represented }: { scope: { kind: 'conversation' | 'topic' | 'org' | 'team' | 'workspace'; principal: string; id?: string }; scopeName: string; represented?: string }) {
  const h = useHuddle();
  const [active, setActive] = useState<boolean | null>(null);
  useEffect(() => {
    let on = true;
    const look = () => { void h.peek(scope).then((r) => { if (on) setActive(!!r && r.state === 'active'); }); };
    look();
    const t = setInterval(look, 15_000);
    return () => { on = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h.peek, scope.kind, scope.principal, scope.id]);
  const here = h.current && h.current.scope.principal === scope.principal && h.current.scope.kind === scope.kind && (h.current.scope.id ?? '') === (scope.id ?? '');
  if (here) return <span className="huddle-here">● In the huddle</span>;
  if (h.current) return null;
  return (
    <button className="huddle-start" disabled={!!h.busy} onClick={() => void (active ? h.join(scope, scopeName, represented) : h.start(scope, scopeName, represented))}>
      {h.busy ?? (active ? '● Join the huddle' : 'Start a huddle')}
    </button>
  );
}
