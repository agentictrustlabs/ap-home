'use client';
// THE HUDDLE, IN HOME — spec 378. One provider above the routed content owns the browser call instance,
// so navigating from a team to its documents does not hang up. Participation is frozen for the life of
// the join: the scope and the represented principal are fixed when you join and change only when you
// leave and join again. Device controls (mic, screen) are the browser's own; Leave stops local capture at
// once, before the server is told.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRealtimeKitClient } from '@cloudflare/realtimekit-react';
import { useSession } from '../../../context/session';
import { huddles, type HuddleRunView, type HuddleScope } from '../../../home/huddles';

export interface HuddleParticipation {
  scope: HuddleScope;
  scopeName: string;
  run: HuddleRunView;
  role: 'host' | 'participant';
  represented?: string;
}

interface HuddleCtx {
  /** The huddle this browser is in, if any — frozen until leave. */
  current: HuddleParticipation | null;
  meeting: ReturnType<typeof useRealtimeKitClient>[0];
  busy: string | null;
  error: string | null;
  micOn: boolean;
  screenOn: boolean;
  /** Start (or join the one already running) at a scope, as the person or as a principal they steward. */
  start: (scope: HuddleScope, scopeName: string, represented?: string) => Promise<void>;
  join: (scope: HuddleScope, scopeName: string, represented?: string) => Promise<void>;
  leave: () => Promise<void>;
  end: () => Promise<void>;
  toggleMic: () => Promise<void>;
  toggleScreen: () => Promise<void>;
  refresh: () => Promise<void>;
  peek: (scope: HuddleScope) => Promise<HuddleRunView | null>;
  dismissError: () => void;
}

const Ctx = createContext<HuddleCtx | null>(null);

export function HuddleProvider({ children }: { children: ReactNode }) {
  const { session, agentName, agentAddress } = useSession();
  const [meeting, initMeeting] = useRealtimeKitClient({ resetOnLeave: true });
  const [current, setCurrent] = useState<HuddleParticipation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const meetingRef = useRef(meeting);
  meetingRef.current = meeting;

  // The SDK's own view of the mic and the screen, mirrored into state so the dock re-renders.
  useEffect(() => {
    if (!meeting) return;
    const self = meeting.self;
    const sync = () => { setMicOn(!!self.audioEnabled); setScreenOn(!!self.screenShareEnabled); };
    sync();
    self.on('audioUpdate', sync);
    self.on('screenShareUpdate', sync);
    return () => { self.off('audioUpdate', sync); self.off('screenShareUpdate', sync); };
  }, [meeting]);

  const enter = useCallback(async (how: 'start' | 'join', scope: HuddleScope, scopeName: string, represented?: string) => {
    if (!session) { setError('Sign in first.'); return; }
    if (current) { setError(`You are already in the ${current.scopeName} huddle — leave it first.`); return; }
    setBusy(how === 'start' ? 'Starting…' : 'Joining…'); setError(null);
    try {
      const display = agentName || (agentAddress ? agentAddress.slice(0, 10) : 'Someone');
      const r = how === 'start' ? await huddles.start(session, scope, display, represented) : await huddles.join(session, scope, display, represented);
      if (!r.ok) { setError(r.notConfigured ? 'Huddles are not set up on this Home yet.' : r.error); return; }
      if (!r.run || !r.authToken) { setError(r.parks ?? 'No huddle to join.'); return; }
      // THE TOKEN: to the SDK, and out of scope. `r` is not kept.
      const m = await initMeeting({ authToken: r.authToken, defaults: { audio: false, video: false } });
      if (!m) { setError('The call could not be set up in this browser.'); return; }
      await m.join();
      setCurrent({ scope, scopeName, run: r.run, role: r.participant?.role ?? 'participant', ...(represented ? { represented } : {}) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }, [session, current, agentName, agentAddress, initMeeting]);

  const leave = useCallback(async () => {
    const m = meetingRef.current;
    // Local capture stops FIRST — the server-side leave may retry; the microphone must not.
    try { if (m?.self.screenShareEnabled) await m.self.disableScreenShare(); } catch { /* already off */ }
    try { if (m?.self.audioEnabled) await m.self.disableAudio(); } catch { /* already off */ }
    try { await m?.leave(); } catch { /* the SDK may already be gone */ }
    const c = current; setCurrent(null); setMicOn(false); setScreenOn(false);
    if (session && c) await huddles.leave(session, c.scope).catch(() => undefined);
  }, [current, session]);

  const end = useCallback(async () => {
    if (!session || !current) return;
    setBusy('Ending…'); setError(null);
    try {
      const c = current;
      await leave();
      const r = await huddles.end(session, c.scope);
      if (!r.ok) setError(r.error);
    } finally { setBusy(null); }
  }, [session, current, leave]);

  const toggleMic = useCallback(async () => { const m = meetingRef.current; if (!m) return; try { if (m.self.audioEnabled) await m.self.disableAudio(); else await m.self.enableAudio(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }, []);
  const toggleScreen = useCallback(async () => { const m = meetingRef.current; if (!m) return; try { if (m.self.screenShareEnabled) await m.self.disableScreenShare(); else await m.self.enableScreenShare(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }, []);

  const refresh = useCallback(async () => {
    if (!session || !current) return;
    const r = await huddles.get(session, current.scope).catch(() => null);
    if (r && r.ok) {
      if (!r.run || r.run.state === 'ended' || r.run.state === 'ending') { await leave(); return; }
      setCurrent((c) => (c ? { ...c, run: r.run! } : c));
    }
  }, [session, current, leave]);
  useEffect(() => { if (!current) return; const t = setInterval(() => { void refresh(); }, 10_000); return () => clearInterval(t); }, [current, refresh]);

  const peek = useCallback(async (scope: HuddleScope) => { if (!session) return null; const r = await huddles.get(session, scope).catch(() => null); return r && r.ok ? r.run : null; }, [session]);

  const value = useMemo<HuddleCtx>(() => ({
    current, meeting, busy, error, micOn, screenOn,
    start: (s, n, r) => enter('start', s, n, r), join: (s, n, r) => enter('join', s, n, r), leave, end, toggleMic, toggleScreen, refresh, peek, dismissError: () => setError(null),
  }), [current, meeting, busy, error, micOn, screenOn, enter, leave, end, toggleMic, toggleScreen, refresh, peek]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useHuddle(): HuddleCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useHuddle must be used within <HuddleProvider>');
  return ctx;
}
