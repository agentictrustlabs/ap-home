'use client';
// Owner administration — issue and revoke discovery grants (spec 338 §20, W6-b).
//
// The grants are REAL: signed by your own custody path, verified on-chain by the resolver before it
// will index them. The Home never signs for you — it forwards a signed object and holds the operator
// token that gates the write.
//
// THE GRANT ID IS SHOWN EXACTLY ONCE. It is a bearer-shaped capability until presented, so it is never
// stored anywhere it could be read back. Losing it means reissuing, which is the correct trade.

import { useCallback, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { signHashFor, type Via } from '../../../home/onboarding';
import { issueDiscoveryGrant, revokeDiscoveryGrant } from '../../../home/resolution';
import { parseDiscoveryAuthorityBundle } from '../../../home/discovery-authority';
import { Card, Row, Stack } from '../../shared/ui';
import { BusyButton } from '../../shared/BusyButton';
import { CHAIN_ID } from '../../../lib/chain';

/** Where the demo resolver lives. A grant is bound to this exact audience. */
const RESOLVER_AUDIENCE = 'https://demo-resolver.richardpedersen3.workers.dev/v1/private';

interface Issued {
  grantId: string;
  subject: string;
  purpose: string;
  expiresAt: string;
  revoked?: boolean;
  /** The agent it makes discoverable, when that is not the signed-in agent. */
  onBehalfOf?: string;
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
  // An appointment pasted in to issue for an agent whose key you do NOT hold (spec 338 W6-c).
  const [bundleText, setBundleText] = useState('');

  // Parsed on every keystroke so a mistyped bundle explains itself here, rather than coming back as
  // an `authority_invalid` from the resolver that the operator has to decode.
  const parsed = useMemo(
    () => (bundleText.trim() ? parseDiscoveryAuthorityBundle(bundleText) : null),
    [bundleText],
  );
  const authority = parsed?.ok ? parsed.bundle : null;

  // The appointment names WHO may use it. Signing in as anyone else produces a grant the resolver
  // refuses, so say it here instead of letting them spend a signature to find out.
  const wrongAppointee =
    !!authority && !!agentAddress &&
    authority.steward.toLowerCase() !== agentAddress.toLowerCase();

  const canIssue =
    !!session && !!agentAddress &&
    /^0x[0-9a-fA-F]{40}$/.test(subject.trim()) &&
    (!bundleText.trim() || (!!authority && !wrongAppointee));

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
          // Present ⇒ the grant is FOR the appointment's target and commits to its delegation.
          // Absent ⇒ it claims self-issuance, which only holds when issuer === target.
          authority: authority
            ? {
                authorityRef: authority.authorityRef,
                targetAgent: authority.targetAgent,
                delegation: authority.delegation,
              }
            : undefined,
        },
        session.token,
      );

      if (!result.ok || !result.grantId) {
        throw new Error(result.detail ?? result.error ?? 'the resolver refused the grant');
      }
      setIssued((prev) => [
        {
          grantId: result.grantId!,
          subject: subject.trim(),
          purpose,
          expiresAt: expiresAt.toISOString(),
          onBehalfOf: authority?.targetAgent,
        },
        ...prev,
      ]);
      setMsg({ kind: 'ok', text: 'Grant issued. Copy the id now — it is not shown again.' });
      setSubject('');
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [session, agentAddress, subject, purpose, surfaces, authority]);

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

        <details style={{ fontSize: '0.8rem' }}>
          <summary style={{ cursor: 'pointer', opacity: 0.8 }}>
            Issuing for an agent you don’t hold the key of?
          </summary>
          <Stack gap={0.35} style={{ marginTop: '0.5rem' }}>
            <p style={{ margin: 0, fontSize: '0.78rem', opacity: 0.72 }}>
              Paste the appointment its keyholder gave you. Your key still signs the grant; the
              appointment is what proves you were allowed to.
            </p>
            <textarea value={bundleText} onChange={(e) => setBundleText(e.target.value)} rows={5}
              placeholder="{ &quot;bundleVersion&quot;: &quot;ap.discovery-authority-bundle/1&quot;, … }"
              spellCheck={false}
              style={{ width: '100%', padding: '0.4rem', borderRadius: 6, border: '1px solid var(--border,#e4e0d8)', fontFamily: 'ui-monospace, monospace', fontSize: '0.7rem', resize: 'vertical' }} />

            {parsed && !parsed.ok && (
              <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.78rem', color: 'var(--danger,#b3261e)' }}>
                {parsed.problems.map((p) => (
                  <li key={`${p.field}:${p.message}`}><code>{p.field}</code> — {p.message}</li>
                ))}
              </ul>
            )}

            {authority && wrongAppointee && (
              <div role="alert" style={{ fontSize: '0.78rem', color: 'var(--danger,#b3261e)' }}>
                This appointment names {authority.steward.slice(0, 10)}…, but you are signed in as{' '}
                {agentAddress?.slice(0, 10)}…. Only the named party can use it.
              </div>
            )}

            {authority && !wrongAppointee && (
              <div style={{ fontSize: '0.78rem', opacity: 0.8 }}>
                Issuing for <code style={{ fontSize: '0.72rem' }}>{authority.targetAgent.slice(0, 12)}…</code>{' '}
                — appointment valid until {new Date(authority.expiresAt).toLocaleDateString()}. The
                resolver re-checks it on-chain; this preview is only a courtesy.
              </div>
            )}
          </Stack>
        </details>

        <Row gap={0.5}>
          <BusyButton busy={busy} busyLabel="Signing…" onClick={issue} disabled={!canIssue}>
            {authority ? 'Issue on their behalf' : 'Issue discovery grant'}
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
                  {i.onBehalfOf && <> · for {i.onBehalfOf.slice(0, 10)}…</>}
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
          Two ways to issue, and the resolver decides which from the grant’s <em>signed</em> body: for
          your own agent, or for one that appointed you. There is no third — an authority reference it
          cannot read is refused, never treated as self-issuance.
        </p>
      </Stack>
    </Card>
  );
}
