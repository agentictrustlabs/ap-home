'use client';
// ONE listing, its whole flow (flow-redesign.md §5, split of 2026-08-30). A "listing" is a place the agent
// appears — its name record, the directory — and each one gets its own screen rather than a row in a stack,
// because there will eventually be many and each has its own status, its own history and its own gate.
// The screen answers three questions in order: what is this place, where do I stand with it, what do I press.
import { useCallback, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { BusyButton } from '../shared/BusyButton';
import { CONTRACTS } from '../../lib/chain';
import { AGENT_REGISTRY_URN } from '../../lib/domain';
import { whitelabel } from '../../whitelabel/config';
import {
  approveProjectionPublication,
  configureProjection,
  executePublicationPlan,
  newMutation,
  planProjectionPublication,
  previewProjection,
  requestProjectionApproval,
  type CardDetail,
  type DelegationWire,
  type StoredProjection,
  type StudioFamily,
} from '../../studio-client';
import type { SignHash } from '../../connect-client';
import { studioErrorSentence } from '../../lib/studio-view';
import { LISTING_PHRASE, listingCatalog, listingRow, lossSentence } from '../../lib/studio-listings';
import { Banner, ErrorLine, LiveRegion } from './ui';
import { Stage, TONE_COLOR, typedNameOf } from './parts';
import { notifyCardChanged } from './useStudio';

export function ListingFlow({
  family, delegation, detail, projections, scopes, sa, agentName, basePath, canSign, signHashFor, onReload,
}: {
  family: StudioFamily;
  delegation: DelegationWire;
  detail: CardDetail;
  projections: readonly StoredProjection[];
  scopes: readonly string[];
  sa: Address;
  agentName: string;
  basePath: string;
  /** May this person's signer act for the agent's account on chain? `null` = unknowable, let the chain decide. */
  canSign: boolean | null;
  signHashFor(): Promise<SignHash>;
  onReload(): void;
}) {
  const typedName = typedNameOf(detail, agentName);
  const descriptor = useMemo(() => listingCatalog({ brand: whitelabel.brand.name, agentName: typedName })[family], [family, typedName]);
  const projection = projections.find((p) => p.family === family) ?? null;
  const published = detail.releases.filter((r) => r.state === 'published').at(-1) ?? null;
  const row = listingRow({ descriptor, projection, published: published ? { releaseId: published.releaseId, signedContentDigest: published.signedContentDigest } : null, scopes, custodian: canSign });
  const notSetUp = family === 'ap-registry' && (!AGENT_REGISTRY_URN || !CONTRACTS.agentRegistryBase);

  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loss, setLoss] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const run = useCallback(async () => {
    if (!published) return;
    setBusy(true); setError(null);
    try {
      setPhase(LISTING_PHRASE.preparing);
      const cfg = await configureProjection(delegation, {
        family,
        ...(family === 'ap-registry' ? { configuration: { registry: CONTRACTS.agentRegistryBase as Address, registryId: AGENT_REGISTRY_URN } as never } : {}),
        cardResourceId: detail.resource.cardResourceId,
        selectedReleaseId: published.releaseId,
      }, newMutation());
      const id = cfg.instance.instanceId;
      const preview = await previewProjection(delegation, id);
      setLoss(lossSentence(descriptor.title, preview.result.losses, detail.draft?.card.skills.length));
      const planned = await planProjectionPublication(delegation, id, newMutation());
      await requestProjectionApproval(delegation, id, planned.plan.planId, newMutation());
      const approved = await approveProjectionPublication(delegation, id, planned.plan.planId, newMutation());
      setPhase(LISTING_PHRASE.custodian);
      const signHash = await signHashFor();
      setPhase(LISTING_PHRASE.writing);
      await executePublicationPlan(sa, signHash, delegation, id, planned, approved.approval.approvalId, newMutation());
      setPhase(LISTING_PHRASE.confirming);
      notifyCardChanged(); onReload();
    } catch (e) {
      setError(studioErrorSentence(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false); setPhase('');
    }
  }, [published, delegation, family, detail.resource.cardResourceId, detail.draft, descriptor.title, sa, signHashFor, onReload]);

  const tone = row.state === 'listed' ? 'good' : row.state === 'out-of-date' ? 'warn' : 'muted';

  return (
    <div>
      <LiveRegion message={phase} />
      <Stage title={descriptor.title} status={{ tone, text: notSetUp ? 'Not set up on this Home yet' : row.line }}>
        <p className="manage-card-blurb" style={{ margin: '0 0 .5rem' }}>{descriptor.purpose}</p>
        {family === 'ap-naming' && typedName && (
          <p className="manage-card-blurb" style={{ margin: '0 0 .5rem', color: TONE_COLOR.good }}>
            Your name <b>{typedName}</b> resolves to this agent ✓
          </p>
        )}
        {!published && (
          <Banner tone="muted">
            Nothing to list yet — the card has to be live first.{' '}
            <a href={basePath} style={{ color: 'var(--c-primary)', fontWeight: 600 }}>Go to Agent Card →</a>
          </Banner>
        )}
        {notSetUp && <Banner tone="muted">This Home hasn&rsquo;t been given a directory to list agents in yet, so there is nothing to publish to.</Banner>}
        {row.secondary && (
          <p className="manage-card-blurb" style={{ margin: '0 0 .4rem', fontSize: '.72rem' }}>
            Written when you last listed it. If this agent has moved since — a new address, a changed name — write
            it again so the record points at where it actually answers.
          </p>
        )}
        {(loss ?? row.loss) && <p className="manage-card-blurb" style={{ margin: '0 0 .4rem', color: TONE_COLOR.warn }}>{loss ?? row.loss}</p>}
        <ErrorLine error={error} />
        <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {!notSetUp && row.button && row.button.id !== 'open' && (
            <BusyButton busy={busy} busyLabel={phase || 'Working…'} className="btn-primary" onClick={() => void run()}>
              {row.button.label}
            </BusyButton>
          )}
          {row.button?.id === 'open' && (
            <button type="button" className="btn-ghost" onClick={() => setDetailsOpen((o) => !o)}>
              {detailsOpen ? 'Hide what it says' : 'See what it says'}
            </button>
          )}
          {row.secondary && (
            <BusyButton busy={busy} busyLabel={phase || 'Working…'} className="btn-ghost" onClick={() => void run()}>
              {row.secondary.label}
            </BusyButton>
          )}
          {projection && row.button?.id !== 'open' && (
            <button type="button" className="btn-ghost" onClick={() => setDetailsOpen((o) => !o)}>
              {detailsOpen ? 'Hide details' : 'Details'}
            </button>
          )}
        </div>
        {projection && detailsOpen && (
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '.15rem .6rem', fontSize: '.7rem', margin: '.5rem 0 0', wordBreak: 'break-all' }}>
            <dt>State</dt><dd style={{ margin: 0 }}>{projection.instance.state}{projection.instance.stateReason ? ` — ${projection.instance.stateReason}` : ''}</dd>
            <dt>Target</dt><dd style={{ margin: 0 }}>{projection.instance.definition.target.specification} {projection.instance.definition.target.version} · adapter {projection.instance.definition.adapter.version}</dd>
            {projection.selectedCard && <><dt>Card version</dt><dd style={{ margin: 0 }}>{projection.selectedCard.releaseId}</dd></>}
            {projection.instance.lastPublication && <><dt>Receipt</dt><dd style={{ margin: 0 }}>{projection.instance.lastPublication.receiptId} · {projection.instance.lastPublication.publishedAt}</dd></>}
            {projection.instance.lastBinding && <><dt>Bound as</dt><dd style={{ margin: 0 }}>{projection.instance.lastBinding.externalId} ({projection.instance.lastBinding.verificationState})</dd></>}
            {projection.instance.lastArtifact && <><dt>Artifact digest</dt><dd style={{ margin: 0 }}>{projection.instance.lastArtifact.artifactDigest}</dd></>}
          </dl>
        )}
      </Stage>
    </div>
  );
}
