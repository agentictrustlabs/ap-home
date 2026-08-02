'use client';
// Owner administration — issue and revoke discovery grants (spec 338 §20, W6-b).
//
// The grants are REAL: signed by your own custody path, verified on-chain by the resolver before it
// will index them. The Home never signs for you — it forwards a signed object and holds the operator
// token that gates the write.
//
// THE GRANT ID IS SHOWN EXACTLY ONCE. It is a bearer-shaped capability until presented, so it is never
// stored anywhere it could be read back. Losing it means reissuing, which is the correct trade.

import { useCallback, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { signHashFor, type Via } from '../../../home/onboarding';
import { issueDiscoveryGrant, revokeDiscoveryGrant } from '../../../home/resolution';
import { Card, Row, Stack } from '../../shared/ui';
import { BusyButton } from '../../shared/BusyButton';

/** Where the demo resolver lives. A grant is bound to this exact audience. */
const RESOLVER_AUDIENCE = 'https://demo-resolver.richardpedersen3.workers.dev/v1/private';
const CHAIN_ID = 84532;

interface Issued {
  grantId: string;
  subject: string;
  purpose: string;
  expiresAt: string;
  revoked?: boolean;
}

export function InvitationsPanel() {
  const { session, agentAddress } = useSession();
  const [subject, setSubject] = useState('');
  const [purpose, setPurpose] = useState('disbursement-reconciliation');
  const [surfaces, setSurfaces] = useState('treasury-reconciliation');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // Session-local only — the grant id is deliberately not persisted anywhere readable.
  const [issued, setIssued] = useState<Issued[]>([]);

  const canIssue = !!session && !!agentAddress && /^0x[0-9a-fA-F]{40}$/.test(subject.trim());

  const issue = useCallback(async () => {
    if (!session || !agentAddress) return;
    setBusy(true);
    setMsg(null);
    try {
      // YOUR key signs the grant. The Home only carries the signed result.
      const sign = await signHashFor(session.via.toLowerCase() as Via, agentAddress as Address, {
        token: session.token,
      });
      const expiresAt = new Date(Date.now() + 30 * 24 * 3600_000);
      const result = await issueDiscoveryGrant(
        {
          agentAddress: agentAddress as Address,
          subjectAddress: subject.trim() as Address,
          chainId: CHAIN_ID,
          resolverAudience: RESOLVER_AUDIENCE,
          purpose: purpose.trim() || undefined,
          allowedSurfaceIds: surfaces.split(',').map((s) => s.trim()).filter(Boolean),
          expiresAt,
          sign,
        },
        session.token,
      );

      if (!result.ok || !result.grantId) {
        throw new Error(result.detail ?? result.error ?? 'the resolver refused the grant');
      }
      setIssued((prev) => [
        { grantId: result.grantId!, subject: subject.trim(), purpose, expiresAt: expiresAt.toISOString() },
        ...prev,
      ]);
      setMsg({ kind: 'ok', text: 'Grant issued. Copy the id now — it is not shown again.' });
      setSubject('');
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [session, agentAddress, subject, purpose, surfaces]);

  const revoke = useCallback(
    async (grantId: string) => {
      if (!session) return;
      setBusy(true);
      setMsg(null);
      try {
        const r = await revokeDiscoveryGrant(grantId, session.token);
        if (!r.ok) throw new Error(r.detail ?? r.error ?? 'revoke failed');
        setIssued((prev) => prev.map((i) => (i.grantId === grantId ? { ...i, revoked: true } : i)));
        setMsg({
          kind: 'ok',
          text: 'Discovery revoked. Any permission you granted them to ACT is a separate control and is untouched.',
        });
      } catch (e) {
        setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(false);
      }
    },
    [session],
  );

  return (
    <Card>
      <Stack gap={0.75}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Let someone find this agent</h3>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', opacity: 0.75 }}>
            A grant lets one party discover how to reach you. It is signed by <em>your</em> key and
            verified on-chain before the resolver will honour it — and it never lets them use anything.
          </p>
        </div>

        <Stack gap={0.4}>
          <label style={{ fontSize: '0.8rem' }}>
            <div style={{ opacity: 0.75, marginBottom: '0.15rem' }}>Their Smart Agent address</div>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
              style={{ width: '100%', padding: '0.4rem', borderRadius: 6, border: '1px solid var(--border,#e4e0d8)', fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' }}
            />
          </label>
          <Row gap={0.5} wrap>
            <label style={{ fontSize: '0.8rem', flex: '1 1 12rem' }}>
              <div style={{ opacity: 0.75, marginBottom: '0.15rem' }}>Purpose</div>
              <input value={purpose} onChange={(e) => setPurpose(e.target.value)}
                style={{ width: '100%', padding: '0.4rem', borderRadius: 6, border: '1px solid var(--border,#e4e0d8)', fontSize: '0.8rem' }} />
            </label>
            <label style={{ fontSize: '0.8rem', flex: '1 1 12rem' }}>
              <div style={{ opacity: 0.75, marginBottom: '0.15rem' }}>Surfaces they may see</div>
              <input value={surfaces} onChange={(e) => setSurfaces(e.target.value)}
                style={{ width: '100%', padding: '0.4rem', borderRadius: 6, border: '1px solid var(--border,#e4e0d8)', fontSize: '0.8rem' }} />
            </label>
          </Row>
        </Stack>

        <Row gap={0.5}>
          <BusyButton busy={busy} busyLabel="Signing…" onClick={issue} disabled={!canIssue}>
            Issue discovery grant
          </BusyButton>
          {!session && <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>Sign in to issue.</span>}
        </Row>

        {msg && (
          <div role={msg.kind === 'err' ? 'alert' : undefined}
            style={{ fontSize: '0.83rem', color: msg.kind === 'err' ? 'var(--danger,#b3261e)' : 'inherit' }}>
            {msg.text}
          </div>
        )}

        {issued.length > 0 && (
          <Stack gap={0.4}>
            <div style={{ fontSize: '0.8rem', opacity: 0.75 }}>Issued this session</div>
            {issued.map((i) => (
              <div key={i.grantId} style={{ border: '1px solid var(--border,#e4e0d8)', borderRadius: 8, padding: '0.6rem 0.75rem' }}>
                <Row justify="space-between" wrap>
                  <code style={{ fontSize: '0.72rem', overflowWrap: 'anywhere' }}>{i.grantId}</code>
                  {i.revoked ? (
                    <span style={{ fontSize: '0.72rem', color: 'var(--danger,#b3261e)', fontWeight: 600 }}>revoked</span>
                  ) : (
                    <button type="button" onClick={() => void revoke(i.grantId)} disabled={busy}
                      style={{ background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer', fontSize: '0.78rem', color: 'var(--danger,#b3261e)' }}>
                      Revoke discovery
                    </button>
                  )}
                </Row>
                <div style={{ fontSize: '0.75rem', opacity: 0.7, marginTop: '0.2rem' }}>
                  {i.purpose} · to {i.subject.slice(0, 10)}… · until {new Date(i.expiresAt).toLocaleDateString()}
                </div>
              </div>
            ))}
            <p style={{ margin: 0, fontSize: '0.76rem', opacity: 0.7 }}>
              Shown once, on purpose — the grant id is the capability, so it is never stored anywhere it
              could be read back. Deliver it over a channel you trust.
            </p>
          </Stack>
        )}

        <p style={{ margin: 0, fontSize: '0.78rem', opacity: 0.7 }}>
          Self-issuance only: you can make <em>your own</em> agent discoverable. Issuing on behalf of an
          agent you custody needs a vault authority record, which is not wired yet — the resolver
          refuses it rather than trusting an unchecked claim.
        </p>
      </Stack>
    </Card>
  );
}
