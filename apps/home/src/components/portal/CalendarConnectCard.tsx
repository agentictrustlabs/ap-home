'use client';
// GOOGLE CONNECTORS — Calendar, Gmail, Drive — each the person's own credential under the delegation model (spec 400 §5.8,
// spec 402 W2). Connecting is her act: an incremental Google authorization whose refresh token the agent runtime keeps
// encrypted under her SA; the Home keeps nothing. Reading is her own standing ("what's on today", "any mail from the
// elders", "find the retreat budget"); the one write each offers (an event, a draft) is an act under her mandate.
// Disconnecting deletes the token — every read after that says "not connected".
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import { Panel, Button, Chip, KeyValue, ErrorNote, Meta, Note, type PanelState } from '../../ui';
import { WorkingBar } from '../onboarding/WorkingBar';

export type ConnectorName = 'calendar' | 'gmail' | 'drive';
type Status = { connected: false } | { connected: true; scope: string | null; account: string | null; canWrite: boolean };

const COPY: Record<ConnectorName, { title: string; reads: string; write?: { label: string; may: string; ask: string }; pitch: string; ask: string }> = {
  calendar: { title: 'Google Calendar', reads: 'read your calendar', write: { label: 'adding events', may: 'add events (each one under your signature)', ask: 'Also let it add events' }, pitch: 'so your agent can answer “what’s on today”, put it on Today, and — if you allow it — add events under your signature', ask: '“what’s on my calendar today”' },
  gmail: { title: 'Gmail', reads: 'read your mail', write: { label: 'writing and sending', may: 'write drafts in your Gmail, and send — only under your signature, one message at a time', ask: 'Also let it write drafts and send' }, pitch: 'so your agent can answer “any mail from the elders this week”, read a thread you point at, and — if you allow it — leave a draft for you to review and send it on your signature', ask: '“any unanswered mail from the elders”' },
  drive: { title: 'Google Drive', reads: 'find and read your files', pitch: 'so your agent can find the document you mean and read a Doc or Sheet you point at — read only', ask: '“find the retreat budget”' },
};

export function connectorClient(token: string, name: ConnectorName) {
  const call = async (body: Record<string, unknown>) => {
    const r = await fetch(`/connect/connector/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
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
/** Kept for the calendar's first callers. */
export const calendarConnector = (token: string) => connectorClient(token, 'calendar');

export function ConnectorCard({ name, returnTo = '/apps' }: { name: ConnectorName; returnTo?: string }) {
  const { session } = useSession();
  const copy = COPY[name];
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<'start' | 'disconnect' | null>(null);
  const [write, setWrite] = useState(false);
  const [justConnected, setJustConnected] = useState(false);

  const load = useCallback(async () => {
    if (!session?.token) return;
    try { setStatus(await connectorClient(session.token, name).status()); setErr(''); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setStatus({ connected: false }); }
  }, [session?.token, name]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    // Back from Google: the callback said whether the token landed — for THIS connector.
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.get('connector') !== name) return;
      const e = u.searchParams.get('error');
      if (e) setErr(`${copy.title} was not connected: ${e}`); else setJustConnected(true);
      u.searchParams.delete('connector'); u.searchParams.delete('error'); u.searchParams.delete('connected');
      window.history.replaceState(null, '', u.toString());
    } catch { /* ignore */ }
  }, [name, copy.title]);

  async function start(withWrite = write) {
    if (!session?.token) return;
    setBusy('start'); setErr('');
    try { window.location.assign(await connectorClient(session.token, name).start(withWrite, returnTo)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(null); }
  }
  async function disconnect() {
    if (!session?.token) return;
    setBusy('disconnect'); setErr('');
    try { await connectorClient(session.token, name).disconnect(); setJustConnected(false); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  const state: PanelState = status === null ? 'loading' : 'ready';
  return (
    <Panel title={copy.title} state={state} rows={2} testId={`connector-${name}`}
      aside={status?.connected ? <Chip tone="ok">connected</Chip> : <Chip>not connected</Chip>}>
      <div className="ui-panel-body">
      {err && <ErrorNote>{err}</ErrorNote>}
      {justConnected && <Note>✓ Connected. Ask {copy.ask}.</Note>}
      {busy && <WorkingBar label={busy === 'start' ? 'Taking you to Google…' : 'Disconnecting…'} />}
      {status?.connected ? (
        <>
          <KeyValue rows={[
            ['Account', status.account || 'a Google account', { absent: !status.account }],
            ['Your agent may', copy.write && status.canWrite ? `${copy.reads} and ${copy.write.may}` : `${copy.reads} — nothing else`],
            ['The credential', 'kept encrypted by the agent runtime under your address; never given to an app, a runtime or a steward'],
          ]} />
          <div style={{ display: 'flex', gap: 8, marginTop: 'var(--sp-3)', flexWrap: 'wrap', alignItems: 'center' }}>
            {copy.write && !status.canWrite && <Button size="sm" disabled={!!busy} onClick={() => { setWrite(true); void start(true); }}>{copy.write.ask}</Button>}
            <Button size="sm" disabled={!!busy} onClick={() => void disconnect()}>Disconnect</Button>
            <Meta>Disconnecting deletes the credential; nothing can {copy.reads} after that.</Meta>
          </div>
        </>
      ) : (
        <>
          <p style={{ margin: '0 0 var(--sp-3)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-body)' }}>
            Connect {copy.title} {copy.pitch}. The connection is yours: revocable here, listed nowhere else.
          </p>
          {copy.write && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 'var(--fs-sm)', marginBottom: 'var(--sp-3)' }}>
              <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} style={{ marginTop: 3 }} />
              <span>Also allow <strong>{copy.write.label}</strong> (each one is an act you sign). Off = read only.</span>
            </label>
          )}
          <Button variant="primary" size="sm" disabled={!!busy || !session} onClick={() => void start()}>Connect {copy.title}</Button>
        </>
      )}
      </div>
    </Panel>
  );
}

/** Kept for the calendar's first callers. */
export const CalendarConnectCard = ({ returnTo }: { returnTo?: string }) => <ConnectorCard name="calendar" {...(returnTo ? { returnTo } : {})} />;
