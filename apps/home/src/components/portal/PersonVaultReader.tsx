'use client';
// Personal vault-records viewer (spec 315 Manage) — the person's own analog of the org Records page
// (`OrgRecordsSection` → `VaultReader`). Shows what's in YOUR vault, read over your interactions grant
// via the self-gated `record.get`. This is the SELF-READABLE capability set (matches the InteractionsDO
// whitelist), NOT the whole vault — the person's own record list is whitelist-gated by design; a full
// "every record" list would need a server `record.list` op. Reads are fired CONCURRENTLY.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from '../../context/session';
import {
  PERSON_CAPABILITY_RECORDS,
  readPersonRecord,
  VaultKeyUnauthorizedError,
  InteractionsNotEnabledError,
  type PersonRecordType,
} from '../../profile-store';

const LABELS: Record<PersonRecordType, string> = {
  'impact-profile': 'Community profile',
  'skills.data': 'Skills',
  'home.manifest': 'Home manifest',
  'control-events.data': 'Activity timeline',
};

type RecordState = { data: unknown; error?: string };

export function PersonVaultReader() {
  const { session, agentAddress } = useSession();
  const [records, setRecords] = useState<Record<string, RecordState> | null>(null);
  const [busy, setBusy] = useState(true);
  const [gate, setGate] = useState<'vault-key' | 'interactions' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!agentAddress) return;
    let cancelled = false;
    setBusy(true);
    setGate(null);
    setErr(null);
    setRecords(null);
    void (async () => {
      try {
        // Read every capability record CONCURRENTLY (they share one owner + one vault key). A per-record
        // non-auth error is captured inline; an auth/enablement failure is shared by all, so it bubbles
        // to the single gate below (ADR-0013: an auth failure is NOT an empty record).
        const results = await Promise.all(
          PERSON_CAPABILITY_RECORDS.map(async (rt) => {
            try {
              return [rt, { data: await readPersonRecord(agentAddress, rt) }] as const;
            } catch (e) {
              if (e instanceof VaultKeyUnauthorizedError || e instanceof InteractionsNotEnabledError) throw e;
              return [rt, { data: null, error: e instanceof Error ? e.message : 'read failed' }] as const;
            }
          }),
        );
        if (!cancelled) setRecords(Object.fromEntries(results));
      } catch (e) {
        if (e instanceof VaultKeyUnauthorizedError) { if (!cancelled) setGate('vault-key'); return; }
        if (e instanceof InteractionsNotEnabledError) { if (!cancelled) setGate('interactions'); return; }
        if (!cancelled) setErr(e instanceof Error ? e.message : 'read failed');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agentAddress]);

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
        The records in YOUR vault, read with your own authority (your interactions grant + vault key). This
        data lives in your vault — the Home only reads it for you, on this device, over your session.
      </p>
      {busy ? (
        <p className="manage-card-blurb">Reading your vault…</p>
      ) : gate === 'vault-key' ? (
        <p className="manage-card-blurb">
          Your vault key isn&rsquo;t active yet. <Link href="/vault-key">Activate your vault key</Link> to read your records.
        </p>
      ) : gate === 'interactions' ? (
        <p className="manage-card-blurb">
          Your interactions plane isn&rsquo;t enabled yet — that&rsquo;s what holds your vault records. Enabling it (via
          sign-in / your home setup) is the one path to a readable vault.
        </p>
      ) : err ? (
        <p className="manage-card-blurb" style={{ color: 'var(--c-danger, #dc2626)' }}>Couldn&rsquo;t read: {err}</p>
      ) : !records ? (
        <p className="manage-card-blurb">No records yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: '.82rem' }}>
          {PERSON_CAPABILITY_RECORDS.map((rt) => {
            const st = records[rt];
            const present = st && st.data != null;
            return (
              <li key={rt} style={{ borderTop: '1px solid var(--c-g100, #eee)', padding: '.45rem 0' }}>
                <strong>{LABELS[rt]}</strong> <code style={{ color: 'var(--c-g500, #64748b)' }}>{rt}</code>{' '}
                {st?.error ? (
                  <span style={{ color: 'var(--c-danger, #dc2626)' }}>· {st.error}</span>
                ) : present ? (
                  <button
                    type="button"
                    onClick={() => setOpen((o) => ({ ...o, [rt]: !o[rt] }))}
                    style={{ background: 'none', border: 'none', color: 'var(--c-accent, #2563eb)', cursor: 'pointer', padding: 0, fontSize: '.8rem' }}
                  >
                    {open[rt] ? 'hide' : 'show'}
                  </button>
                ) : (
                  <span style={{ color: 'var(--c-g500, #64748b)' }}>· empty</span>
                )}
                {present && open[rt] && (
                  <pre style={{ background: 'var(--c-g50, #f8fafc)', padding: '.45rem .6rem', borderRadius: 6, overflowX: 'auto', fontSize: '.72rem', margin: '.3rem 0 0' }}>
                    {JSON.stringify(st.data, null, 2)}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
