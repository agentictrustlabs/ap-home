'use client';
// Names & Bindings (design §9). FIVE things that answer different questions and can legitimately disagree —
// ownership · resolution · canonical identity · current card publication · registry binding. Keeping them
// as separate rows is the whole point: a name can resolve while the card it points at is stale.
import { useCallback, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { ExternalIdentityBindingV1 } from '@agenticprimitives/registry-kit/projection';
import { VERSION_LABELS } from '@agenticprimitives/home';
import { BusyButton } from '../shared/BusyButton';
import { AddressChip } from '../shared/AddressChip';
import { verifyBinding, type CardDetail, type DelegationWire, type StoredProjection } from '../../studio-client';
import { gateForOp, targetLabel } from '../../lib/studio-view';
import { Chip, Digest, ErrorLine } from './ui';

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ borderTop: '1px solid var(--c-g200)', padding: '.7rem 0' }}>
      <h3 style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--c-g500)', margin: '0 0 .3rem' }}>{title}</h3>
      {children}
    </section>
  );
}

export function NamesAndBindings({
  delegation,
  detail,
  projections,
  bindings,
  scopes,
  sa,
  agentName,
}: {
  delegation: DelegationWire;
  detail: CardDetail;
  projections: readonly StoredProjection[];
  bindings: readonly ExternalIdentityBindingV1[];
  scopes: readonly string[];
  sa: Address;
  agentName: string;
}) {
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, { ok: boolean; detail: string | null }>>({});
  const [error, setError] = useState<string | null>(null);

  const published = [...detail.releases].reverse().find((r) => r.state === 'published') ?? null;
  const latest = detail.releases[detail.releases.length - 1] ?? null;
  const latestDigest = latest?.signedContentDigest ?? latest?.unsignedContentDigest ?? null;
  const naming = projections.find((p) => p.family === 'ap-naming') ?? null;
  const namingDigest = naming?.instance.desiredSources.selectedCardDigest ?? null;
  const registryBindings = bindings.filter((b) => b.target.family === 'ap-registry');

  const check = useCallback(
    async (bindingId: string) => {
      setVerifying(bindingId);
      setError(null);
      try {
        const res = await verifyBinding(delegation, bindingId);
        setVerdicts((v) => ({ ...v, [bindingId]: { ok: res.verdict.ok, detail: res.verdict.detail } }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setVerifying(null);
      }
    },
    [delegation],
  );

  return (
    <div className="manage-card">
      <ErrorLine error={error} />

      <Row title="Ownership">
        <p className="manage-card-blurb" style={{ margin: 0 }}>
          This name is owned by the agent itself:
        </p>
        <div style={{ marginTop: '.25rem' }}>
          <AddressChip address={sa} size="sm" />
        </div>
      </Row>

      <Row title="Resolution">
        {agentName ? (
          <>
            <p style={{ fontSize: '.8rem', margin: 0 }}>
              <b>{agentName}</b> → <code style={{ fontSize: '.75rem' }}>{sa}</code>
            </p>
            <p className="manage-card-blurb" style={{ margin: 0 }}>
              Anyone can look this name up and get this address.
            </p>
          </>
        ) : (
          <p className="manage-card-blurb" style={{ margin: 0 }}>
            This agent has no public name — nothing resolves to it yet.
          </p>
        )}
      </Row>

      <Row title="Canonical identity">
        <p style={{ fontSize: '.8rem', margin: 0 }}>
          <code style={{ fontSize: '.75rem' }}>{sa}</code> — the Smart Agent. This never changes; names,
          credentials and cards all point at it.
        </p>
      </Row>

      <Row title="Current card publication">
        {published ? (
          <>
            <p style={{ fontSize: '.8rem', margin: 0 }}>
              {VERSION_LABELS.cardRelease} {published.releaseNumber} · <Digest value={published.signedContentDigest ?? published.unsignedContentDigest} />
            </p>
            {published.publication?.uri && (
              <p className="manage-card-blurb" style={{ margin: '.15rem 0' }}>
                published at{' '}
                <a href={published.publication.uri} target="_blank" rel="noreferrer">
                  {published.publication.uri}
                </a>
              </p>
            )}
            <p className="manage-card-blurb" style={{ margin: '.15rem 0' }}>
              {naming ? (
                namingDigest && latestDigest && namingDigest === latestDigest ? (
                  <>
                    The name record carries <Digest value={namingDigest} label="atl:cardDigest" /> <Chip tone="good">✓ matches</Chip>
                  </>
                ) : (
                  <>
                    The name record carries <Digest value={namingDigest ?? '—'} label="atl:cardDigest" />{' '}
                    <Chip tone="warn">⚠ doesn&rsquo;t match the latest release yet</Chip> — publish the AP Naming
                    projection to catch it up.
                  </>
                )
              ) : (
                'No card is linked to this name yet — configure the AP Naming projection to publish the card digest onto the name record.'
              )}
            </p>
          </>
        ) : (
          <p className="manage-card-blurb" style={{ margin: 0 }}>
            No card release is published yet. Nothing is being served at the well-known endpoint.
          </p>
        )}
      </Row>

      <Row title="Registry binding">
        {registryBindings.length === 0 ? (
          <p className="manage-card-blurb" style={{ margin: 0 }}>
            No registry entry is bound to this agent yet.
          </p>
        ) : (
          registryBindings.map((b) => {
            const v = verdicts[b.bindingId];
            return (
              <div key={b.bindingId} style={{ display: 'flex', alignItems: 'center', gap: '.4rem', flexWrap: 'wrap', padding: '.2rem 0' }}>
                <span style={{ fontSize: '.8rem' }}>
                  {targetLabel(b.target.family)} entry <code style={{ fontSize: '.75rem' }}>{b.externalId}</code>
                </span>
                <Chip tone={b.lifecycle.state === 'active' ? 'good' : b.lifecycle.state === 'revoked' ? 'danger' : 'warn'}>{b.lifecycle.state}</Chip>
                <Chip tone={b.verification.state === 'verified' ? 'good' : b.verification.state === 'failed' ? 'danger' : 'warn'}>{b.verification.state}</Chip>
                <BusyButton
                  busy={verifying === b.bindingId}
                  busyLabel="Checking…"
                  className="btn-ghost"
                  disabled={!gateForOp(scopes, 'binding.verify').allowed}
                  title={gateForOp(scopes, 'binding.verify').reason}
                  onClick={() => void check(b.bindingId)}
                >
                  Verify binding
                </BusyButton>
                {v && (
                  <span style={{ fontSize: '.75rem', color: v.ok ? 'var(--color-sage-700)' : 'var(--c-danger)' }}>
                    {v.ok ? 'Verified against the chain.' : `Not verified: ${v.detail ?? 'the on-chain entry does not match'}`}
                  </span>
                )}
              </div>
            );
          })
        )}
      </Row>
    </div>
  );
}
