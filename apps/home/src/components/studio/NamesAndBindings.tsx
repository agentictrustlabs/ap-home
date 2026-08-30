'use client';
// Names & Bindings (design §9, rev. 2026-08-30). Answers ONE question: where can this agent be found, and
// does each public record agree with the card you published? Ownership / resolution / canonical identity /
// current card publication / registry binding are five things that CAN legitimately disagree — but on a
// first visit, before anything is released, three of five rows are empty, and the healthy case (everything
// agrees) doesn't need three separately-labelled facts to say so once. `namesAndBindingsRows` (studio-view.ts)
// is the pure state machine behind every line here — this component only renders it and layers the
// interactive "Verify binding" check on top.
import { useCallback, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { ExternalIdentityBindingV1 } from '@agenticprimitives/registry-kit/projection';
import { BusyButton } from '../shared/BusyButton';
import { AddressChip } from '../shared/AddressChip';
import { verifyBinding, type CardDetail, type DelegationWire, type StoredProjection } from '../../studio-client';
import { gateForOp, namesAndBindingsRows, targetLabel, type NamesAndBindingsRow } from '../../lib/studio-view';
import { Chip, Digest, ErrorLine } from './ui';

const ROW_TITLE: Record<NamesAndBindingsRow['id'], string> = {
  identity: 'Identity',
  publication: 'Card publication',
  registry: 'Registry binding',
};

const ROW_TONE: Record<NamesAndBindingsRow['state'], 'good' | 'muted' | 'warn' | 'danger'> = {
  ok: 'good',
  empty: 'muted',
  stale: 'warn',
  mismatch: 'danger',
};

const ROW_GLYPH: Record<NamesAndBindingsRow['state'], string> = {
  ok: '✓',
  empty: '—',
  stale: '⚠',
  mismatch: '✕',
};

function StateRow({ row }: { row: NamesAndBindingsRow }) {
  return (
    <section style={{ borderTop: '1px solid var(--c-g200)', padding: '.7rem 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '.5rem', flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--c-g500)', margin: 0 }}>{ROW_TITLE[row.id]}</h3>
        <Chip tone={ROW_TONE[row.state]}>
          <span aria-hidden>{ROW_GLYPH[row.state]}</span> {row.state === 'ok' ? 'Agrees' : row.state === 'empty' ? 'Not yet' : row.state === 'stale' ? 'Needs attention' : 'Mismatch'}
        </Chip>
      </div>
      <p style={{ fontSize: '.82rem', margin: '.3rem 0 0', color: row.state === 'mismatch' ? 'var(--c-danger)' : 'var(--c-g900)' }}>{row.line}</p>
      {row.next && (
        <a href={row.next.href} style={{ display: 'inline-block', marginTop: '.35rem', fontSize: '.78rem', fontWeight: 600, color: 'var(--c-primary)' }}>
          {row.next.label} →
        </a>
      )}
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
  releasesHref,
  projectionsHref,
}: {
  delegation: DelegationWire;
  detail: CardDetail;
  projections: readonly StoredProjection[];
  bindings: readonly ExternalIdentityBindingV1[];
  scopes: readonly string[];
  sa: Address;
  agentName: string;
  releasesHref: string;
  projectionsHref: string;
}) {
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, { ok: boolean; detail: string | null }>>({});
  const [error, setError] = useState<string | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);

  const published = [...detail.releases].reverse().find((r) => r.state === 'published') ?? null;
  const latest = detail.releases[detail.releases.length - 1] ?? null;
  const latestDigest = latest?.signedContentDigest ?? latest?.unsignedContentDigest ?? null;
  const hasSignedRelease = detail.releases.some((r) => r.state === 'signed');
  const naming = projections.find((p) => p.family === 'ap-naming') ?? null;
  const namingDigest = naming?.instance.desiredSources.selectedCardDigest ?? null;
  const registryBindings = bindings.filter((b) => b.target.family === 'ap-registry');

  const rows = namesAndBindingsRows({
    agentName,
    hasSignedRelease,
    published: published ? { releaseNumber: published.releaseNumber, uri: published.publication?.uri ?? null } : null,
    namingConfigured: !!naming,
    namingDigestMatches: naming ? (!!namingDigest && !!latestDigest && namingDigest === latestDigest) : null,
    registryBindings,
    releasesHref,
    projectionsHref,
  });
  const identityRow = rows.find((r) => r.id === 'identity')!;
  const publicationRow = rows.find((r) => r.id === 'publication')!;
  const registryRow = rows.find((r) => r.id === 'registry')!;

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
      <p className="manage-card-blurb" style={{ margin: '0 0 .5rem' }}>
        Where this agent can be found, and whether each public record agrees with the card you published.
      </p>
      <ErrorLine error={error} />

      <StateRow row={identityRow} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', margin: '.3rem 0 0', flexWrap: 'wrap' }}>
        <span className="manage-card-blurb" style={{ margin: 0 }}>
          Canonical identity — this never changes, however the name or the card evolves:
        </span>
        <AddressChip address={sa} size="sm" />
      </div>
      <button
        type="button"
        className="btn-ghost"
        style={{ marginTop: '.4rem', minHeight: 30, padding: '.2rem .5rem', fontSize: '.72rem' }}
        aria-expanded={whyOpen}
        onClick={() => setWhyOpen((o) => !o)}
      >
        {whyOpen ? 'Hide' : 'Why'} ownership, resolution and canonical identity are different questions
      </button>
      {whyOpen && (
        <p className="manage-card-blurb" style={{ margin: '.35rem 0 0' }}>
          <b>Ownership</b> is who controls the name record. <b>Resolution</b> is the public mapping anyone can
          look up — the name pointing at this agent&rsquo;s address. <b>Canonical identity</b> is the Smart
          Agent address itself, the one thing that never rotates. They usually agree, which is why this page
          shows them as one line — but a name can resolve while pointing at the wrong owner, or an owner can
          change a name&rsquo;s target without the card catching up, which is exactly when a steward needs to
          see them apart.
        </p>
      )}

      <StateRow row={publicationRow} />
      {published && naming && namingDigest && (
        <p className="manage-card-blurb" style={{ margin: '.3rem 0 0' }}>
          Name record carries <Digest value={namingDigest} label="atl:cardDigest" />
          {latestDigest === namingDigest ? <Chip tone="good" style={{ marginLeft: '.3rem' }}>✓ matches</Chip> : null}
        </p>
      )}

      <StateRow row={registryRow} />
      {registryBindings.length > 0 && (
        <div style={{ marginTop: '.3rem', display: 'grid', gap: '.3rem' }}>
          {registryBindings.map((b) => {
            const v = verdicts[b.bindingId];
            return (
              <div key={b.bindingId} style={{ display: 'flex', alignItems: 'center', gap: '.4rem', flexWrap: 'wrap' }}>
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
          })}
        </div>
      )}
    </div>
  );
}
