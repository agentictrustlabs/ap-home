'use client';
// Personal vault-records viewer (spec 315 Manage) — the person's own analog of the org Records page
// (`OrgRecordsSection` → `VaultReader`). Lists the person's OWN Home-managed vault records (self-gated
// `record.list`) and reads each on demand (`record.get`). demo-mcp scope-filters both to the interactions
// grant, so app-specific records written under a DIFFERENT app's grant (e.g. a relying app's own records)
// never appear here — least-privilege. Reads defer to demo-mcp's record-scope gate, never a silent empty.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from '../../context/session';
import { BusyButton } from '../shared/BusyButton';
import { activateInteractionsIfNeeded, resolveVia } from '../../home/onboarding';
import {
  listPersonRecords,
  readPersonRecord,
  VaultKeyUnauthorizedError,
  InteractionsNotEnabledError,
  type PersonVaultRecordRef,
} from '../../profile-store';

// Friendly labels for the known Home-managed record types; unknown/wildcard types fall back to the raw id.
function labelFor(recordType: string): string {
  const exact: Record<string, string> = {
    'impact-profile': 'Community profile',
    // `skills.data` — the vault-resident CAPABILITY CLAIM CREDENTIALS (facet-registries.md §7); the
    // record-type key is legacy and immutable (it addresses live vault rows), the label is canonical.
    'capabilities.data': 'Your capability record',
    'skills.data': 'Your capability record',   // the same record under its pre-ADR-0051 name
    'home.manifest': 'Home manifest',
    'control-events.data': 'Activity timeline',
    'inbox.data': 'Inbox',
    'relationships.data': 'Relationships',
    'directory.data': 'Directory listing',
  };
  if (exact[recordType]) return exact[recordType];
  if (recordType.startsWith('member.profile:')) return 'Member profile';
  if (recordType.startsWith('org.membership:')) return 'Org membership';
  if (recordType.startsWith('conversation.') || recordType.startsWith('topic.')) return 'Conversation';
  if (recordType.startsWith('message.body:')) return 'Message body';
  return recordType;
}

export function PersonVaultReader() {
  const { session, agentAddress, profile } = useSession();
  const [records, setRecords] = useState<PersonVaultRecordRef[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [gate, setGate] = useState<'vault-key' | 'interactions' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [enabling, setEnabling] = useState(false);
  const [enableErr, setEnableErr] = useState<string | null>(null);

  /** Re-issue the interactions grant + DEL-001 session leaf, then re-read. `force` because a STALE grant
   *  still reports as granted; without it the activation short-circuits and the member stays stuck. */
  const enableInteractions = useCallback(async () => {
    if (!agentAddress || !session?.token) return;
    setEnabling(true); setEnableErr(null);
    try {
      const via = resolveVia(profile?.credential as string | undefined, session.via);
      const res = await activateInteractionsIfNeeded(agentAddress, via, { token: session.token }, true);
      if (!res.ok) { setEnableErr(res.error); return; }
      window.location.reload();
    } catch (e) {
      setEnableErr(String((e as Error)?.message ?? e));
    } finally {
      setEnabling(false);
    }
  }, [agentAddress, session?.token, session?.via, profile?.credential]);

  useEffect(() => {
    if (!agentAddress) return;
    let cancelled = false;
    setBusy(true);
    setGate(null);
    setErr(null);
    setRecords(null);
    void listPersonRecords(agentAddress)
      .then((r) => { if (!cancelled) setRecords(r.sort((a, b) => a.record_type.localeCompare(b.record_type))); })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof VaultKeyUnauthorizedError) setGate('vault-key');
        else if (e instanceof InteractionsNotEnabledError) setGate('interactions');
        else setErr(e instanceof Error ? e.message : 'read failed');
      })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [agentAddress]);

  const show = useCallback(async (recordType: string) => {
    setOpen((o) => ({ ...o, [recordType]: !o[recordType] }));
    if (bodies[recordType] || !agentAddress) return;
    try {
      const data = await readPersonRecord(agentAddress, recordType);
      setBodies((b) => ({ ...b, [recordType]: JSON.stringify(data, null, 2) }));
    } catch (e) {
      setBodies((b) => ({ ...b, [recordType]: `(error: ${e instanceof Error ? e.message : 'read failed'})` }));
    }
  }, [agentAddress, bodies]);

  if (!session) {
    return (
      <div className="dash-section">
        <h3 className="subhead">Records</h3>
        <p className="manage-card-blurb">Sign in to read your vault records.</p>
      </div>
    );
  }

  return (
    <div className="dash-section" style={{ marginTop: '1.25rem' }}>
      <h3 className="subhead">Your vault records</h3>
      <p className="manage-card-blurb" style={{ margin: '0 0 .6rem' }}>
        The records in YOUR vault that your Home is entitled to read (your interactions grant + vault key).
        This data lives in your vault — the Home reads it for you, on this device, over your session. Records
        an app writes under its own grant aren&rsquo;t listed here; view those inside that app.
      </p>
      {busy ? (
        <p className="manage-card-blurb">Reading your vault…</p>
      ) : gate === 'vault-key' ? (
        <p className="manage-card-blurb">
          Your vault key isn&rsquo;t active yet. <Link href="/vault-key">Activate your vault key</Link> to read your records.
        </p>
      ) : gate === 'interactions' ? (
        // "Enable it via sign-in" is not a path a person already signed in can take. A grant also goes
        // stale when the interactions-session key rotates — the stored DEL-001 leaf still names the old
        // signer — and that leaves a returning member reading an instruction they cannot act on. So the
        // action lives here, and it re-issues rather than telling someone to leave and come back.
        <div>
          <p className="manage-card-blurb">
            Your interactions plane isn&rsquo;t enabled — that&rsquo;s what holds your vault records. Enabling it
            signs one grant from your agent; nothing else changes.
          </p>
          <BusyButton
            busy={enabling}
            busyLabel="Enabling…"
            className="btn-primary"
            onClick={() => void enableInteractions()}
          >
            Enable interactions
          </BusyButton>
          {enableErr && <p className="manage-card-blurb" style={{ color: 'var(--c-danger, #dc2626)' }}>{enableErr}</p>}
        </div>
      ) : err ? (
        <p className="manage-card-blurb" style={{ color: 'var(--c-danger, #dc2626)' }}>Couldn&rsquo;t read: {err}</p>
      ) : !records || records.length === 0 ? (
        <p className="manage-card-blurb">No records yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: '.82rem' }}>
          {records.map((r) => (
            <li key={r.record_type} style={{ borderTop: '1px solid var(--c-g100, #eee)', padding: '.45rem 0' }}>
              <strong>{labelFor(r.record_type)}</strong> <code style={{ color: 'var(--c-g500, #64748b)' }}>{r.record_type}</code>
              {r.updated_at && <span style={{ color: 'var(--c-g400, #94a3b8)' }}> · {r.updated_at}</span>}{' '}
              <button
                type="button"
                onClick={() => void show(r.record_type)}
                style={{ background: 'none', border: 'none', color: 'var(--c-accent, #2563eb)', cursor: 'pointer', padding: 0, fontSize: '.8rem' }}
              >
                {open[r.record_type] ? 'hide' : 'show'}
              </button>
              {open[r.record_type] && (
                <pre style={{ background: 'var(--c-g50, #f8fafc)', padding: '.45rem .6rem', borderRadius: 6, overflowX: 'auto', fontSize: '.72rem', margin: '.3rem 0 0' }}>
                  {bodies[r.record_type] ?? 'Reading…'}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
