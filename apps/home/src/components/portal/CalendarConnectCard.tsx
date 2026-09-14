'use client';
// GOOGLE CALENDAR — a connector under the delegation model (spec 400 W4). Connecting is the person's act: an
// incremental Google authorization whose refresh token the agent runtime keeps encrypted under her SA; the Home keeps
// nothing. Reading her calendar is her own standing ("what's on my calendar today" — Today, the Ask, Claude through
// the Home MCP, a paired runtime all get the harness's answer AS her); adding an event is an act under her mandate.
// Disconnecting deletes the token — every read after that says "not connected".
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import { Panel, Button, Chip, KeyValue, ErrorNote, Meta, Note, type PanelState } from '../../ui';
import { WorkingBar } from '../onboarding/WorkingBar';

type Status = { connected: false } | { connected: true; scope: string | null; account: string | null; canWrite: boolean };

export function calendarConnector(token: string) {
  const call = async (body: Record<string, unknown>) => {
    const r = await fetch('/connect/connector/calendar', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok || j.ok === false) throw new Error(String(j.error ?? `HTTP ${r.status}`));
    return j;
  };
  return {
    status: async (): Promise<Status> => { const j = await call({ action: 'status' }); return j.connected ? { connected: true, scope: (j.scope as string | null) ?? null, account: (j.account as string | null) ?? null, canWrite: j.canWrite === true } : { connected: false }; },
    start: async (write: boolean, returnTo: string): Promise<string> => String((await call({ action: 'start', write, returnTo })).url),
    disconnect: async () => { await call({ action: 'disconnect' }); },
  };
}

export function CalendarConnectCard({ returnTo = '/apps' }: { returnTo?: string }) {
  const { session } = useSession();
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<'start' | 'disconnect' | null>(null);
  const [write, setWrite] = useState(false);
  const [justConnected, setJustConnected] = useState(false);

  const load = useCallback(async () => {
    if (!session?.token) return;
    try { setStatus(await calendarConnector(session.token).status()); setErr(''); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setStatus({ connected: false }); }
  }, [session?.token]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    // Back from Google: the callback said whether the token landed.
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.get('connector') !== 'calendar') return;
      const e = u.searchParams.get('error');
      if (e) setErr(`Google Calendar was not connected: ${e}`); else setJustConnected(true);
      u.searchParams.delete('connector'); u.searchParams.delete('error'); u.searchParams.delete('connected');
      window.history.replaceState(null, '', u.toString());
    } catch { /* ignore */ }
  }, []);

  async function start() {
    if (!session?.token) return;
    setBusy('start'); setErr('');
    try { window.location.assign(await calendarConnector(session.token).start(write, returnTo)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(null); }
  }
  async function disconnect() {
    if (!session?.token) return;
    setBusy('disconnect'); setErr('');
    try { await calendarConnector(session.token).disconnect(); setJustConnected(false); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  const state: PanelState = status === null ? 'loading' : 'ready';
  return (
    <Panel title="Google Calendar" state={state} rows={2} testId="calendar-connector"
      aside={status?.connected ? <Chip tone="ok">connected</Chip> : <Chip>not connected</Chip>}>
      <div className="ui-panel-body">
      {err && <ErrorNote>{err}</ErrorNote>}
      {justConnected && <Note>✓ Connected. Ask “what’s on my calendar today” — or see it on Today.</Note>}
      {busy && <WorkingBar label={busy === 'start' ? 'Taking you to Google…' : 'Disconnecting…'} />}
      {status?.connected ? (
        <>
          <KeyValue rows={[
            ['Account', status.account || 'a Google account', { absent: !status.account }],
            ['Your agent may', status.canWrite ? 'read your calendar and add events (each add under your signature)' : 'read your calendar — nothing else'],
            ['The credential', 'kept encrypted by the agent runtime under your address; never given to an app, a runtime or a steward'],
          ]} />
          <div style={{ display: 'flex', gap: 8, marginTop: 'var(--sp-3)', flexWrap: 'wrap', alignItems: 'center' }}>
            {!status.canWrite && <Button size="sm" disabled={!!busy} onClick={() => { setWrite(true); void start(); }}>Also let it add events</Button>}
            <Button size="sm" disabled={!!busy} onClick={() => void disconnect()}>Disconnect</Button>
            <Meta>Disconnecting deletes the credential; nothing can read your calendar after that.</Meta>
          </div>
        </>
      ) : (
        <>
          <p style={{ margin: '0 0 var(--sp-3)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-body)' }}>
            Connect your calendar so your agent can answer “what’s on today”, put it on Today, and — if you allow it — add events under your signature. The connection is yours: revocable here, listed nowhere else.
          </p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 'var(--fs-sm)', marginBottom: 'var(--sp-3)' }}>
            <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} style={{ marginTop: 3 }} />
            <span>Also allow <strong>adding events</strong> (each one is an act you sign). Off = read only.</span>
          </label>
          <Button variant="primary" size="sm" disabled={!!busy || !session} onClick={() => void start()}>Connect Google Calendar</Button>
        </>
      )}
      </div>
    </Panel>
  );
}
