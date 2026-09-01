'use client';
// Appoint someone to make this agent discoverable (spec 338 W6-c).
//
// THE GAP THIS CLOSES: issuing used to require holding the agent's key, so an agent administered by
// someone other than its keyholder could not be made discoverable at all. Now the keyholder signs
// ONCE, and the appointee issues from then on without them.
//
// WHAT THE OPERATOR NEEDS TO UNDERSTAND, and what this panel therefore says out loud:
//   • it authorizes ONE method — issuing discovery grants. Not using, spending, or custodying.
//   • it expires, and can be revoked on-chain, because it is an ordinary delegation.
//   • the bundle is not a bearer secret: only the NAMED appointee can use it, proving its own key.
//
// The Home does not sign for you here any more than it does anywhere else — `signHashFor` routes to
// your own custody path, and what comes back is a signature over the EIP-712 delegation digest.

import { useCallback, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { signHashFor, type Via } from '../../../home/onboarding';
import { mintDiscoveryAuthority, type DiscoveryAuthorityBundle } from '../../../home/discovery-authority';
import { Card, Row, Stack } from '../../shared/ui';
import { BusyButton } from '../../shared/BusyButton';

const input: React.CSSProperties = {
  width: '100%',
  padding: '0.4rem',
  borderRadius: 6,
  border: '1px solid var(--border,#e4e0d8)',
  fontFamily: 'ui-monospace, monospace',
  fontSize: '0.8rem',
};

export function DiscoveryAuthorityPanel() {
  const { session, agentAddress } = useSession();
  const [steward, setSteward] = useState('');
  const [days, setDays] = useState('90');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [bundle, setBundle] = useState<DiscoveryAuthorityBundle | null>(null);
  const [copied, setCopied] = useState(false);

  const dayCount = Number(days);
  const canMint =
    !!session &&
    !!agentAddress &&
    /^0x[0-9a-fA-F]{40}$/.test(steward.trim()) &&
    Number.isFinite(dayCount) &&
    dayCount > 0;

  const mint = useCallback(async () => {
    if (!session || !agentAddress) return;
    setBusy(true);
    setMsg(null);
    setBundle(null);
    setCopied(false);
    try {
      const sign = await signHashFor(session.via.toLowerCase() as Via, agentAddress as Address, {
        token: session.token,
      });
      const out = await mintDiscoveryAuthority({
        agentAddress: agentAddress as Address,
        stewardAddress: steward.trim() as Address,
        expiresAt: new Date(Date.now() + dayCount * 24 * 3600_000),
        sign,
      });
      setBundle(out);
      setMsg({ kind: 'ok', text: 'Appointed. Send them the bundle below.' });
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [session, agentAddress, steward, dayCount]);

  const bundleJson = bundle ? JSON.stringify(bundle, null, 2) : '';

  return (
    <Card>
      <Stack gap={0.75}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Let someone else make this agent discoverable</h3>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', opacity: 0.75 }}>
            Sign once, and they can issue discovery grants for this agent without you. It is an
            ordinary delegation — scoped to one action, time-boxed, and revocable on-chain.
          </p>
        </div>

        <Row gap={0.5} wrap>
          <label style={{ fontSize: '0.8rem', flex: '2 1 16rem' }}>
            <div style={{ opacity: 0.75, marginBottom: '0.15rem' }}>Their Smart Agent address</div>
            <input value={steward} onChange={(e) => setSteward(e.target.value)} placeholder="0x…"
              spellCheck={false} style={input} />
          </label>
          <label style={{ fontSize: '0.8rem', flex: '1 1 7rem' }}>
            <div style={{ opacity: 0.75, marginBottom: '0.15rem' }}>Valid for (days)</div>
            <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" style={input} />
          </label>
        </Row>

        <Row gap={0.5}>
          <BusyButton busy={busy} busyLabel="Signing…" onClick={mint} disabled={!canMint}>
            Appoint
          </BusyButton>
          {!session && <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>Sign in to appoint.</span>}
        </Row>

        {msg && (
          <div role={msg.kind === 'err' ? 'alert' : undefined}
            style={{ fontSize: '0.83rem', color: msg.kind === 'err' ? 'var(--danger,#b3261e)' : 'inherit' }}>
            {msg.text}
          </div>
        )}

        {bundle && (
          <Stack gap={0.4}>
            <Row justify="space-between" wrap>
              <div style={{ fontSize: '0.8rem', opacity: 0.75 }}>
                {bundle.steward.slice(0, 10)}… may issue until{' '}
                {new Date(bundle.expiresAt).toLocaleDateString()}
              </div>
              <button type="button"
                onClick={() => { void navigator.clipboard.writeText(bundleJson).then(() => setCopied(true)); }}
                style={{ background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer', fontSize: '0.78rem', color: 'var(--color-text-body)' }}>
                {copied ? 'Copied' : 'Copy bundle'}
              </button>
            </Row>
            <textarea readOnly value={bundleJson} rows={8}
              style={{ ...input, fontSize: '0.7rem', resize: 'vertical' }} />
            <p style={{ margin: 0, fontSize: '0.76rem', opacity: 0.7 }}>
              Unlike a grant id, this is not a bearer capability — only{' '}
              <code style={{ fontSize: '0.72rem' }}>{bundle.steward.slice(0, 10)}…</code> can use it,
              and only by signing with its own key. Send it over a channel you trust anyway: it reveals
              that this agent exists and who administers it.
            </p>
          </Stack>
        )}

        <p style={{ margin: 0, fontSize: '0.78rem', opacity: 0.7 }}>
          This appoints them to say <em>where</em> this agent is — never to use it. Finding an agent is
          not permission to call it, and the two are revoked independently.
        </p>
      </Stack>
    </Card>
  );
}
