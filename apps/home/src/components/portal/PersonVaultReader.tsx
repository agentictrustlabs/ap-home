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
import { Section, List, Row, Empty, Unknown, Meta, Mono, Button } from '../../ui';
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
  // Spec 410 §8 — the countersigned form of a relationship: one credential, two signatures, this vault's copy.
  if (recordType.startsWith('relationships.credential:')) return 'Membership credential (countersigned)';
  if (recordType.startsWith('relationships.revocation:')) return 'Membership credential revoked';
  if (recordType.startsWith('run.anchor:')) return 'Run anchor (where its receipt is anchored)';
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

  /** Spec 410 §8 — PRESENT a countersigned relationship: the credential with its TERMS WITHHELD (the signed body commits
   *  to them by digest), as a file the counterparty verifies against both Smart Agents' signatures — never by reading
   *  the chain's edge, never by asking this Home. What leaves: kind, the two parties, when, the two signatures. */
  const present = useCallback(async (recordType: string) => {
    if (!agentAddress) return;
    try {
      const data = (await readPersonRecord(agentAddress, recordType)) as Record<string, unknown> | null;
      if (!data) return;
      const { terms: _withheld, ...presentation } = data; void _withheld;
      const text = JSON.stringify({ ...presentation, presentedAt: new Date().toISOString(), verify: 'both signatures over the RFC 8785 digest of the body, each against its party\'s Smart Agent (ERC-1271 / 6492) — the terms are withheld on purpose; the body commits to them by termsDigest' }, null, 2);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `${recordType.replace(/[^A-Za-z0-9._-]/g, '_')}.presentation.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setBodies((b) => ({ ...b, [recordType]: `(error: ${e instanceof Error ? e.message : 'read failed'})` }));
    }
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
      <div>
        <Empty>Sign in to read your vault records.</Empty>
      </div>
    );
  }

  return (
    <Section title="Your vault records" count={records?.length || undefined} aside={<span>read by your Home on this device, over your session — an app's own records are inside that app</span>}>
      {busy ? (
        <Meta>Reading your vault…</Meta>
      ) : gate === 'vault-key' ? (
        <Empty title="Your vault key isn't active yet"><Link href="/vault-key">Activate your vault key</Link> to read your records.</Empty>
      ) : gate === 'interactions' ? (
        // "Enable it via sign-in" is not a path a person already signed in can take. A grant also goes
        // stale when the interactions-session key rotates — the stored DEL-001 leaf still names the old
        // signer — and that leaves a returning member reading an instruction they cannot act on. So the
        // action lives here, and it re-issues rather than telling someone to leave and come back.
        <Empty title="Your interactions plane isn't enabled" action={<BusyButton busy={enabling} busyLabel="Enabling…" className="ui-btn ui-btn--primary" onClick={() => void enableInteractions()}>Enable interactions</BusyButton>}>
          That is what holds your vault records. Enabling it signs one grant from your agent; nothing else changes.
          {enableErr && <div className="ui-error" style={{ marginTop: 8 }}>{enableErr}</div>}
        </Empty>
      ) : err ? (
        <Unknown read={<>your vault could not be read ({err})</>} />
      ) : !records || records.length === 0 ? (
        <Empty>No records yet.</Empty>
      ) : (
        <List>
          {records.map((r) => (
            <Row
              key={r.record_type}
              title={labelFor(r.record_type)}
              meta={<><Mono>{r.record_type}</Mono>{r.updated_at ? ` · ${r.updated_at}` : ''}</>}
              side={<>
                {r.record_type.startsWith('relationships.credential:') && <Button size="sm" variant="ghost" title="Download this credential with its terms withheld, for a counterparty to verify" onClick={() => void present(r.record_type)}>Present</Button>}
                {' '}<Button size="sm" variant="ghost" onClick={() => void show(r.record_type)}>{open[r.record_type] ? 'Hide' : 'Show'}</Button>
              </>}
            >
              {open[r.record_type] && (
                <pre className="ui-mono" style={{ background: 'var(--color-surface-sunken)', padding: '8px 10px', borderRadius: 8, overflowX: 'auto', margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>
                  {bodies[r.record_type] ?? 'Reading…'}
                </pre>
              )}
            </Row>
          ))}
        </List>
      )}
    </Section>
  );
}
