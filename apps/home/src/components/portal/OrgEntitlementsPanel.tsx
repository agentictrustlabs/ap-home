'use client';
// Org ENTITLEMENTS console — uupg-interop port of the GC impact home's vault MembersPanel (spec 277).
// Org-authority surface: grant a MEMBER (a different SA) scoped read access to this org's vault via a
// signed entitlement — access is by the credential, NOT custody. Issue / list / revoke present the
// org's stewardship authority; "Test access" reads the org record AS a member you custody, proving the
// entitlement is the gate (revoke ⇒ the same read fails closed).
//
// Adaptations from impact: this repo's session context (useSession → via/token) instead of impact's
// ConnectVia plumbing, this repo's form/card styling (networks page / OrgDetail inline-style idiom),
// and recordType is a FREE-TEXT input with datalist suggestions (uupg relying apps bring their own
// record types, e.g. `uupg:attestation`) instead of impact's fixed select.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import type { DelegationWire } from '../../lib/delegation';
import {
  issueOrgEntitlement,
  listOrgEntitlements,
  revokeOrgEntitlement,
  readOrgAsMember,
  type IssuedEntitlement,
} from '../../lib/entitlements-admin';
import type { Via } from '../../home/onboarding';

import { Loading } from '../shared/Loading';
const RECORD_SUGGESTIONS = ['impact-profile', 'impact-entitlements', 'uupg:attestation'];

const inputStyle: React.CSSProperties = {
  padding: '0.5rem 0.7rem',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-8)',
  font: 'inherit',
  background: 'var(--color-surface)',
};

export function OrgEntitlementsPanel({ org, stewardship, requester }: {
  org: Address;
  stewardship: DelegationWire;
  requester: Address;
}) {
  const { session } = useSession();
  const auth = { stewardship, requester };
  const [issued, setIssued] = useState<IssuedEntitlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [form, setForm] = useState({ member: '', recordType: 'impact-profile', days: '' });
  const [test, setTest] = useState<{ id: string; result: string; tone: 'ok' | 'bad' } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    listOrgEntitlements(auth)
      .then((list) => { if (alive) setIssued(list); })
      .catch(() => { if (alive) setIssued([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // The wire is stable per org; re-list on explicit refresh or an org switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, org]);

  async function onIssue() {
    const member = form.member.trim();
    const recordType = form.recordType.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(member)) { setErr("Enter the member's Smart Agent address (0x…)."); return; }
    if (member.toLowerCase() === org.toLowerCase()) { setErr('The member must be a different agent than the org.'); return; }
    if (!recordType) { setErr('Enter the record type the member may read.'); return; }
    setErr(null); setBusy(true);
    const days = Number(form.days);
    const out = await issueOrgEntitlement(auth, {
      member: member as Address,
      recordType,
      ...(days > 0 ? { ttlSeconds: Math.round(days * 86400) } : {}),
    });
    setBusy(false);
    if (out.ok) { setForm({ member: '', recordType: form.recordType, days: '' }); setRefresh((k) => k + 1); }
    else setErr(out.error);
  }

  async function onRevoke(id: string) {
    setErr(null); setBusy(true);
    const out = await revokeOrgEntitlement(auth, id);
    setBusy(false);
    if (out.ok) setRefresh((k) => k + 1); else setErr(out.error);
  }

  async function onTest(e: IssuedEntitlement) {
    if (!session) { setTest({ id: e.id, result: 'Not signed in.', tone: 'bad' }); return; }
    setTest({ id: e.id, result: 'Reading as the member…', tone: 'ok' });
    try {
      // Signs a member self-delegation with YOUR credential — only demonstrable when the member is
      // one of your OWN agents (you custody it). For anyone else's SA this fails gracefully below.
      const out = await readOrgAsMember({
        member: e.member,
        via: session.via.toLowerCase() as Via,
        token: session.token,
        owner: org,
        recordType: e.recordType,
      });
      if (out.ok) {
        const n = out.data && typeof out.data === 'object' ? Object.keys(out.data as object).length : 0;
        setTest({ id: e.id, result: `Allowed — read ${n} field group(s)${out.allowedFields ? ` (fields: ${out.allowedFields.join(', ')})` : ''}.`, tone: 'ok' });
      } else {
        setTest({ id: e.id, result: `Denied${out.reason ? ` (${out.reason})` : ''}: ${out.error}`, tone: 'bad' });
      }
    } catch (ex) {
      setTest({ id: e.id, result: `Couldn't read as the member: ${ex instanceof Error ? ex.message : String(ex)}`, tone: 'bad' });
    }
  }

  return (
    <div style={{ display: 'grid', gap: '0.9rem' }}>
      {err && <p style={{ color: 'var(--color-danger)', fontSize: '.85rem', margin: 0 }}>{err}</p>}

      <div className="manage-card" style={{ display: 'grid', gap: '0.6rem' }}>
        <div>
          <b style={{ fontSize: '.95rem' }}>Grant a member access</b>
          <p className="manage-card-blurb" style={{ margin: '0.2rem 0 0' }}>
            Issue a signed entitlement so a member (a different Smart Agent) can read a scoped record of
            this org&apos;s vault — gated by the credential, never by custody. Revoke any time.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={form.member}
            onChange={(e) => setForm((f) => ({ ...f, member: e.target.value }))}
            placeholder="Member Smart Agent (0x…)"
            aria-label="Member address"
            style={{ ...inputStyle, flex: 1, minWidth: 280, fontFamily: 'var(--font-mono, monospace)' }}
          />
          <input
            value={form.recordType}
            onChange={(e) => setForm((f) => ({ ...f, recordType: e.target.value }))}
            placeholder="Record type"
            aria-label="Record type"
            list="org-entitlement-record-suggestions"
            style={{ ...inputStyle, width: 190 }}
          />
          <datalist id="org-entitlement-record-suggestions">
            {RECORD_SUGGESTIONS.map((r) => <option key={r} value={r} />)}
          </datalist>
          <input
            value={form.days}
            onChange={(e) => setForm((f) => ({ ...f, days: e.target.value }))}
            placeholder="Days (blank = no expiry)"
            inputMode="numeric"
            aria-label="Validity days"
            style={{ ...inputStyle, width: 170 }}
          />
          <button className="btn-primary" style={{ width: 'auto' }} onClick={() => void onIssue()} disabled={busy}>
            {busy ? '…' : 'Issue entitlement'}
          </button>
        </div>
        <p style={{ fontSize: '.74rem', color: 'var(--color-text-muted)', margin: 0 }}>
          Tip: to see the member side, use one of your OWN agents (treasury / another org) as the member —
          &quot;Test access&quot; then reads as it.
        </p>
      </div>

      {loading && issued.length === 0 ? (
        <Loading label="Loading issued entitlements…" />
      ) : issued.length === 0 ? (
        <p className="manage-card-blurb">
          No member entitlements yet. Issue one above to grant a member scoped, revocable access to this org&apos;s vault.
        </p>
      ) : (
        issued.map((e) => (
          <div key={e.id} className="manage-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <b>{e.recordType}</b>
                  <span className={`manage-card-badge${e.status === 'granted' ? ' live' : ''}`}>{e.status}</span>
                </div>
                <div style={{ fontSize: '.78rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
                  member <code>{e.member.slice(0, 8)}…{e.member.slice(-4)}</code>
                  {e.validUntil ? ` · expires ${new Date(e.validUntil).toLocaleDateString()}` : ' · no expiry'}
                  {` · granted ${new Date(e.createdAt).toLocaleDateString()}`}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button className="btn-ghost" style={{ width: 'auto' }} onClick={() => void onTest(e)} disabled={busy}>Test access</button>
                {e.status === 'granted' && (
                  <button className="btn-ghost" style={{ width: 'auto', color: 'var(--color-danger)' }} onClick={() => void onRevoke(e.id)} disabled={busy}>
                    Revoke
                  </button>
                )}
              </div>
            </div>
            {test && test.id === e.id && (
              <p style={{ fontSize: '.8rem', marginTop: '0.6rem', marginBottom: 0, color: test.tone === 'bad' ? 'var(--color-danger)' : 'var(--color-sage-700)' }}>
                {test.result}
              </p>
            )}
          </div>
        ))
      )}
    </div>
  );
}
