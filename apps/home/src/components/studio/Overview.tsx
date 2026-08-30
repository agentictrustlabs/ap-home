'use client';
// The Card & Projections LANDING (flow-redesign.md): three ordered stages, one primary action each. The state
// machine, the two signatures, the projections — all still real, all still enforced by the service — but the
// steward drives a job ("make my agent findable and reachable"), not our lifecycle. Pure decisions live in
// `lib/studio-flow.ts` / `lib/studio-listings.ts`; this file only renders and orchestrates the calls.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { A2AAgentCardReleaseV1, CardDraftState } from '@agenticprimitives/agent-profile/a2a';
import { signedCardContentDigest } from '@agenticprimitives/agent-profile/a2a';
import { A2A_CARD_EDITOR_MANIFEST } from '@agenticprimitives/home';
import { BusyButton } from '../shared/BusyButton';
import { CHAIN_ID, CONTRACTS } from '../../lib/chain';
import { A2A_DOMAIN, AGENT_NAME_PARENT, AGENT_REGISTRY_URN } from '../../lib/domain';
import { whitelabel } from '../../whitelabel/config';
import {
  approveProjectionPublication,
  approveRelease,
  buildSmartAgentBinding,
  configureProjection,
  createRelease,
  deprecateRelease,
  executePublicationPlan,
  newCardSigningKey,
  newMutation,
  planProjectionPublication,
  previewProjection,
  publishRelease,
  requestProjectionApproval,
  requestReleaseApproval,
  revokeRelease,
  signRelease,
  signReleaseLocally,
  signSmartAgentBinding,
  validateCard,
  verifyReleasePublication,
  type CardDetail,
  type DelegationWire,
  type ReleaseSignature,
  type StoredProjection,
  type StudioFamily,
  type ValidationReport,
} from '../../studio-client';
import type { SignHash } from '../../connect-client';
import { cardUriForName, publicationVerdict, studioErrorSentence, type PublicationVerdict } from '../../lib/studio-view';
import { BINDING_PROMPT, PUBLISH_PHRASE, describeStage, liveStage, planPublish, type PublishPlan, type StageStatus } from '../../lib/studio-flow';
import { LISTING_PHRASE, listingCatalog, listingRow, lossSentence, type ListingRow } from '../../lib/studio-listings';
import { CardEditor } from './CardEditor';
import { Inspector, type PanelId } from './Inspector';
import { ReleaseStepper } from './ReleaseStepper';
import { Banner, Chip, ErrorLine, LiveRegion, inputStyle } from './ui';
import { notifyCardChanged } from './useStudio';

function decodeKid(protectedHeader: string): string {
  const json = atob(protectedHeader.replace(/-/g, '+').replace(/_/g, '/'));
  const kid = (JSON.parse(json) as { kid?: string }).kid;
  if (!kid) throw new Error('the prepared card signature carries no kid');
  return kid;
}

const TONE_COLOR: Record<StageStatus['tone'], string> = { good: 'var(--color-sage-700, #3f6b4a)', warn: 'var(--c-warn, #b45309)', muted: 'var(--c-g700)' };

function Stage({ n, title, status, dimmed, id, children }: { n: string; title: string; status: { tone: StageStatus['tone']; text: string }; dimmed?: boolean; id?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`stage-${n}`} className="manage-card" style={{ marginBottom: '.8rem', opacity: dimmed ? 0.62 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '.8rem', flexWrap: 'wrap' }}>
        <h2 id={`stage-${n}`} className="subhead" style={{ margin: 0 }}>
          <span aria-hidden style={{ display: 'inline-block', width: 22, height: 22, lineHeight: '22px', textAlign: 'center', borderRadius: 999, background: 'var(--c-primary-subtle)', color: 'var(--c-primary)', fontSize: '.72rem', marginRight: '.45rem' }}>{n}</span>
          {title}
        </h2>
        <span style={{ fontSize: '.78rem', fontWeight: 700, color: TONE_COLOR[status.tone] }}>{status.text}</span>
      </div>
      <div style={{ marginTop: '.5rem' }}>{children}</div>
    </section>
  );
}

/** A persistent (not one-shot) URL flag, so the editor sub-screen survives a refresh and the back button. */
function useUrlFlag(name: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try { setOn(new URL(window.location.href).searchParams.get(name) === '1'); } catch { /* no window */ }
  }, [name]);
  const set = useCallback((next: boolean) => {
    setOn(next);
    try {
      const url = new URL(window.location.href);
      if (next) url.searchParams.set(name, '1'); else url.searchParams.delete(name);
      window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch { /* no window */ }
  }, [name]);
  useEffect(() => {
    const onPop = () => { try { setOn(new URL(window.location.href).searchParams.get(name) === '1'); } catch { /* ignore */ } };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [name]);
  return [on, set];
}

export function Overview({
  delegation, detail, projections, scopes, sa, agentName, signHashFor, onDetail, onReload,
  initialPointer, initialDiagnostic, initialPanel, staleBanner,
}: {
  delegation: DelegationWire;
  detail: CardDetail;
  projections: readonly StoredProjection[];
  scopes: readonly string[];
  sa: Address;
  agentName: string;
  signHashFor(): Promise<SignHash>;
  onDetail(next: CardDetail): void;
  onReload(): void;
  initialPointer?: string | null;
  initialDiagnostic?: string | null;
  initialPanel?: PanelId | null;
  staleBanner?: boolean;
}) {
  const [editing, setEditing] = useUrlFlag('edit');
  const [editorDiagnostic, setEditorDiagnostic] = useState<string | null>(initialDiagnostic ?? null);
  const [editorPointer, setEditorPointer] = useState<string | null>(initialPointer ?? null);
  useEffect(() => { if (initialDiagnostic || initialPointer) setEditing(true); }, [initialDiagnostic, initialPointer, setEditing]);

  // ── stage ①: the description is checked automatically whenever it changes ────────────────────────────
  const draft = detail.draft;
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [checking, setChecking] = useState(false);
  const lastCheckedRevision = useRef<number | null>(null);
  useEffect(() => {
    if (!draft) return;
    if (lastCheckedRevision.current === draft.revision) return;
    lastCheckedRevision.current = draft.revision;
    const t = setTimeout(() => {
      setChecking(true);
      validateCard(delegation, detail.resource.cardResourceId)
        .then((r) => setValidation(r))
        .catch(() => setValidation(null))
        .finally(() => setChecking(false));
    }, 400);
    return () => clearTimeout(t);
  }, [delegation, detail.resource.cardResourceId, draft]);

  const errors = validation?.errors ?? 0;
  const latest = detail.releases.length > 0 ? detail.releases[detail.releases.length - 1]! : null;
  const published = detail.releases.filter((r) => r.state === 'published').at(-1) ?? null;
  const draftChanged = !!draft && (!latest || draft.basedOnReleaseId !== latest.releaseId);
  const cardUri = useMemo(() => cardUriForName(agentName, { nameParent: AGENT_NAME_PARENT, a2aDomain: A2A_DOMAIN }), [agentName]);

  const describe = describeStage({ draftState: draft?.state ?? null, errors, checked: !!validation, skillCount: draft?.card.skills.length ?? 0, name: draft?.card.name ?? agentName });
  const plan: PublishPlan = planPublish({ draftState: draft?.state ?? null, errors, release: latest, draftChanged, scopes });

  // ── stage ②: one button, the whole chain ─────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<string>('');
  const [busy, setBusy] = useState<'publish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastVerdict, setLastVerdict] = useState<PublicationVerdict | null>(null);
  const [bindingAsk, setBindingAsk] = useState<{ resolve(choice: 'sign' | 'skip'): void } | null>(null);
  const [bindingUri, setBindingUri] = useState(cardUri ?? '');
  useEffect(() => { if (cardUri) setBindingUri(cardUri); }, [cardUri]);

  const askBinding = () => new Promise<'sign' | 'skip'>((resolve) => setBindingAsk({ resolve }));

  const runPublish = useCallback(async () => {
    if (plan.kind !== 'ready') return;
    setBusy('publish'); setError(null);
    try {
      setPhase(PUBLISH_PHRASE.check);
      const v = await validateCard(delegation, detail.resource.cardResourceId);
      setValidation(v);
      if (v.errors > 0) return;
      let release: A2AAgentCardReleaseV1 | null = plan.steps[0] === 'create-release' ? null : latest;
      const cardId = detail.resource.cardResourceId;
      for (const step of plan.runnable) {
        setPhase(PUBLISH_PHRASE[step]);
        if (step === 'create-release') { release = (await createRelease(delegation, cardId, newMutation())).release; continue; }
        if (!release) throw new Error('no version to work on');
        if (step === 'request-approval') { release = (await requestReleaseApproval(delegation, cardId, release.releaseId, newMutation())).release; continue; }
        if (step === 'approve') { release = (await approveRelease(delegation, cardId, release.releaseId, newMutation())).release; continue; }
        if (step === 'sign') {
          const key = await newCardSigningKey();
          const prepared = await signReleaseLocally(release, key);
          let sig: ReleaseSignature = prepared;
          if (bindingUri.trim()) {
            const choice = await askBinding();
            setBindingAsk(null);
            if (choice === 'sign') {
              setPhase('Waiting for your custodian…');
              const binding = buildSmartAgentBinding({ chainId: CHAIN_ID, sa, release, signedCardDigest: signedCardContentDigest(prepared.signedCard), cardUri: bindingUri.trim(), kid: decodeKid(prepared.signature.protected) });
              const signHash = await signHashFor();
              sig = { ...prepared, smartAgentBinding: await signSmartAgentBinding(sa, CHAIN_ID, signHash, binding) };
              setPhase(PUBLISH_PHRASE.sign);
            }
          }
          release = (await signRelease(delegation, cardId, release.releaseId, sig, newMutation())).release;
          continue;
        }
        if (step === 'publish') {
          const res = await publishRelease(delegation, cardId, release.releaseId, newMutation());
          release = res.release; setLastVerdict(publicationVerdict(res.receipt));
          continue;
        }
        if (step === 'verify' && release.state !== 'published') {
          const res = await verifyReleasePublication(delegation, cardId, release.releaseId);
          release = res.release; setLastVerdict(publicationVerdict(res.receipt));
        }
      }
      notifyCardChanged(); onReload();
    } catch (e) {
      setError(studioErrorSentence(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null); setPhase(''); setBindingAsk(null);
    }
  }, [plan, delegation, detail.resource.cardResourceId, latest, bindingUri, sa, signHashFor, onReload]);

  const live = liveStage({ plan, release: latest, cardUri, lastVerdict });
  const waitingOnSomeoneElse = plan.kind === 'ready' && plan.stopAt !== null && plan.runnable.length === 0;

  // ── stage ③: listings ────────────────────────────────────────────────────────────────────────────────
  const catalog = useMemo(() => listingCatalog({ brand: whitelabel.brand.name, agentName }), [agentName]);
  const [listingBusy, setListingBusy] = useState<StudioFamily | null>(null);
  const [listingPhase, setListingPhase] = useState('');
  const [listingLoss, setListingLoss] = useState<Partial<Record<StudioFamily, string | null>>>({});
  const [listingError, setListingError] = useState<Partial<Record<StudioFamily, string>>>({});
  const [detailsOpen, setDetailsOpen] = useState<Partial<Record<StudioFamily, boolean>>>({});
  const byFamily = useMemo(() => Object.fromEntries(projections.map((p) => [p.family, p])) as Partial<Record<StudioFamily, StoredProjection>>, [projections]);
  const rows: ListingRow[] = (['ap-naming', 'ap-registry'] as StudioFamily[]).map((f) =>
    listingRow({ descriptor: catalog[f], projection: byFamily[f] ?? null, published: published ? { releaseId: published.releaseId, signedContentDigest: published.signedContentDigest } : null, scopes }),
  );
  const directoryConfigured = !!AGENT_REGISTRY_URN && !!CONTRACTS.agentRegistryBase;

  const runListing = useCallback(async (family: StudioFamily) => {
    if (!published) return;
    setListingBusy(family); setListingError((e) => ({ ...e, [family]: undefined }));
    try {
      setListingPhase(LISTING_PHRASE.preparing);
      const cfg = await configureProjection(delegation, {
        family,
        ...(family === 'ap-registry' ? { configuration: { registry: CONTRACTS.agentRegistryBase as Address, registryId: AGENT_REGISTRY_URN } as never } : {}),
        cardResourceId: detail.resource.cardResourceId,
        selectedReleaseId: published.releaseId,
      }, newMutation());
      const id = cfg.instance.instanceId;
      const preview = await previewProjection(delegation, id);
      setListingLoss((l) => ({ ...l, [family]: lossSentence(catalog[family].title, preview.result.losses, published.signedCard?.skills.length ?? preview.bundle.skillClaims.length) }));
      const planned = await planProjectionPublication(delegation, id, newMutation());
      await requestProjectionApproval(delegation, id, planned.plan.planId, newMutation());
      const approved = await approveProjectionPublication(delegation, id, planned.plan.planId, newMutation());
      setListingPhase(LISTING_PHRASE.custodian);
      const signHash = await signHashFor();
      setListingPhase(LISTING_PHRASE.writing);
      await executePublicationPlan(sa, signHash, delegation, id, planned, approved.approval.approvalId, newMutation());
      setListingPhase(LISTING_PHRASE.confirming);
      notifyCardChanged(); onReload();
    } catch (e) {
      setListingError((err) => ({ ...err, [family]: studioErrorSentence(e instanceof Error ? e.message : String(e)) }));
    } finally {
      setListingBusy(null); setListingPhase('');
    }
  }, [published, delegation, detail.resource.cardResourceId, catalog, sa, signHashFor, onReload]);

  // ── History + Advanced ───────────────────────────────────────────────────────────────────────────────
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => { if (typeof window !== 'undefined' && window.location.hash === '#history') setHistoryOpen(true); }, []);
  const [inspectorOpen, setInspectorOpen] = useState(!!initialPanel);
  const [panel, setPanel] = useState<PanelId>(initialPanel ?? (A2A_CARD_EDITOR_MANIFEST.inspectorPanels[0] as PanelId));
  const [revokeReason, setRevokeReason] = useState('');
  const [historyBusy, setHistoryBusy] = useState<string | null>(null);

  if (editing) {
    return (
      <div>
        <button type="button" className="btn-ghost" style={{ marginBottom: '.6rem' }} onClick={() => { setEditing(false); setEditorDiagnostic(null); setEditorPointer(null); }}>
          ← Back to overview
        </button>
        <CardEditor
          delegation={delegation}
          detail={detail}
          projections={projections}
          scopes={scopes}
          onDetail={onDetail}
          onReload={onReload}
          initialPointer={editorPointer}
          initialDiagnostic={editorDiagnostic}
          initialPanel={initialPanel ?? null}
          staleBanner={staleBanner}
        />
      </div>
    );
  }

  const name = draft?.card.name || agentName || 'this agent';
  const description = draft?.card.description ?? '';

  return (
    <div>
      <LiveRegion message={phase || listingPhase} />
      <p className="manage-card-blurb" style={{ margin: '0 0 .8rem' }}>
        Make <b>{name}</b> findable and reachable. Three steps, in order — each one tells you what to do next.
      </p>

      <Stage n="①" title="Describe your agent" status={{ tone: describe.tone, text: checking ? 'Checking…' : describe.status }}>
        <p className="manage-card-blurb" style={{ margin: '0 0 .4rem' }}>{describe.body}</p>
        {description && <p style={{ fontSize: '.85rem', margin: '0 0 .5rem', color: 'var(--c-g700)' }}>&ldquo;{description.length > 180 ? `${description.slice(0, 180)}…` : description}&rdquo;</p>}
        <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
          {describe.action?.id === 'show-problems' && (
            <button type="button" className="btn-primary" onClick={() => { setEditorDiagnostic(validation?.diagnostics.find((d) => d.severity === 'error')?.code ?? null); setEditing(true); }}>
              Show me
            </button>
          )}
          <button type="button" className={describe.action?.id === 'edit' ? 'btn-primary' : 'btn-ghost'} onClick={() => setEditing(true)}>
            Edit description
          </button>
        </div>
      </Stage>

      <Stage n="②" title="Make it live" status={{ tone: live.tone, text: live.status }} dimmed={plan.kind === 'blocked' || !cardUri}>
        <p className="manage-card-blurb" style={{ margin: '0 0 .35rem' }}>{live.body}</p>
        <p className="manage-card-blurb" style={{ margin: '0 0 .5rem', fontSize: '.72rem' }}>{live.explain}</p>
        <ErrorLine error={error} />
        {waitingOnSomeoneElse && plan.kind === 'ready' && plan.stopAt && (
          <>
            <Banner tone="muted">{plan.stopAt.line}</Banner>
            <ReleaseStepper delegation={delegation} detail={detail} release={latest} draftState={draft?.state ?? null} sa={sa} agentName={agentName} scopes={scopes} signHashFor={signHashFor} onReload={onReload} />
          </>
        )}
        {bindingAsk && (
          <div role="dialog" aria-labelledby="binding-title" style={{ border: '1px solid var(--c-primary)', borderRadius: 8, padding: '.7rem', margin: '.4rem 0' }}>
            <div id="binding-title" style={{ fontWeight: 700, fontSize: '.85rem' }}>{BINDING_PROMPT.title}</div>
            <p className="manage-card-blurb">{BINDING_PROMPT.body}</p>
            <label style={{ display: 'block', fontSize: '.72rem', color: 'var(--c-g500)', margin: '.3rem 0 .15rem' }} htmlFor="binding-uri">Address the signature names</label>
            <input id="binding-uri" value={bindingUri} onChange={(e) => setBindingUri(e.target.value)} style={inputStyle} />
            <div style={{ display: 'flex', gap: '.4rem', marginTop: '.5rem' }}>
              <button type="button" className="btn-primary" onClick={() => bindingAsk.resolve('sign')}>{BINDING_PROMPT.sign}</button>
              <button type="button" className="btn-ghost" onClick={() => bindingAsk.resolve('skip')}>{BINDING_PROMPT.skip}</button>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {(live.action?.id === 'publish' || live.action?.id === 'republish') && !waitingOnSomeoneElse && (
            <BusyButton busy={busy === 'publish'} busyLabel={phase || 'Publishing…'} className="btn-primary" disabled={plan.kind !== 'ready'} onClick={() => void runPublish()}>
              {live.action.label}
            </BusyButton>
          )}
          {plan.kind === 'blocked' && (
            <>
              <button type="button" className="btn-primary" disabled title={plan.line}>Publish</button>
              <span className="manage-card-blurb">{plan.line}</span>
              <button type="button" className="btn-ghost" onClick={() => { setEditorDiagnostic(validation?.diagnostics.find((d) => d.severity === 'error')?.code ?? null); setEditing(true); }}>Show me</button>
            </>
          )}
          {live.action?.id === 'open' && cardUri && (
            <a className="btn-ghost" href={cardUri} target="_blank" rel="noreferrer">Open</a>
          )}
        </div>
      </Stage>

      <Stage n="③" title="List it" status={{ tone: published ? 'muted' : 'muted', text: published ? `${rows.filter((r) => r.state === 'listed').length} of ${rows.length} listed` : 'Publish the card first' }} dimmed={!published} id="list">
        <p className="manage-card-blurb" style={{ margin: '0 0 .5rem' }}>
          Where <b>{name}</b> appears so agents and people can find it. Each place needs one listing; you can update it whenever the card changes.
        </p>
        {agentName && <p className="manage-card-blurb" style={{ margin: '0 0 .5rem', color: TONE_COLOR.good }}>Your name <b>{agentName}</b> resolves to this agent ✓</p>}
        <div style={{ display: 'grid', gap: '.5rem' }}>
          {rows.map((row) => {
            const notSetUp = row.family === 'ap-registry' && !directoryConfigured;
            const p = row.projection;
            return (
              <div key={row.family} style={{ border: '1px solid var(--c-g200)', borderRadius: 8, padding: '.6rem .7rem', display: 'grid', gap: '.25rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '.6rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '.85rem' }}>{row.title}</div>
                    <div className="manage-card-blurb" style={{ margin: 0 }}>{row.purpose}</div>
                  </div>
                  <div style={{ fontSize: '.76rem', fontWeight: 600, color: row.state === 'listed' ? TONE_COLOR.good : row.state === 'out-of-date' ? TONE_COLOR.warn : TONE_COLOR.muted }}>
                    {notSetUp ? 'Not set up on this Home yet' : row.line}
                  </div>
                </div>
                {(listingLoss[row.family] ?? row.loss) && <p className="manage-card-blurb" style={{ margin: 0, color: TONE_COLOR.warn }}>{listingLoss[row.family] ?? row.loss}</p>}
                <ErrorLine error={listingError[row.family] ?? null} />
                <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  {!notSetUp && row.button && row.button.id !== 'open' && (
                    <BusyButton busy={listingBusy === row.family} busyLabel={listingPhase || 'Working…'} className="btn-primary" onClick={() => void runListing(row.family)}>
                      {row.button.label}
                    </BusyButton>
                  )}
                  {row.button?.id === 'open' && row.family === 'ap-naming' && <a className="btn-ghost" href="/naming">Open</a>}
                  {p && (
                    <button type="button" className="btn-ghost" onClick={() => setDetailsOpen((d) => ({ ...d, [row.family]: !d[row.family] }))}>
                      {detailsOpen[row.family] ? 'Hide details' : 'Details'}
                    </button>
                  )}
                </div>
                {p && detailsOpen[row.family] && (
                  <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '.15rem .6rem', fontSize: '.7rem', margin: '.3rem 0 0', wordBreak: 'break-all' }}>
                    <dt>State</dt><dd style={{ margin: 0 }}>{p.instance.state}{p.instance.stateReason ? ` — ${p.instance.stateReason}` : ''}</dd>
                    <dt>Target</dt><dd style={{ margin: 0 }}>{p.instance.definition.target.specification} {p.instance.definition.target.version} · adapter {p.instance.definition.adapter.version}</dd>
                    {p.selectedCard && <><dt>Card version</dt><dd style={{ margin: 0 }}>{p.selectedCard.releaseId}</dd></>}
                    {p.instance.lastPublication && <><dt>Receipt</dt><dd style={{ margin: 0 }}>{p.instance.lastPublication.receiptId} · {p.instance.lastPublication.publishedAt}</dd></>}
                    {p.instance.lastBinding && <><dt>Bound as</dt><dd style={{ margin: 0 }}>{p.instance.lastBinding.externalId} ({p.instance.lastBinding.verificationState})</dd></>}
                    {p.instance.lastArtifact && <><dt>Artifact digest</dt><dd style={{ margin: 0 }}>{p.instance.lastArtifact.artifactDigest}</dd></>}
                  </dl>
                )}
              </div>
            );
          })}
        </div>
      </Stage>

      <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', margin: '.4rem 0 .8rem' }}>
        <button type="button" className="btn-ghost" id="history" onClick={() => setHistoryOpen((o) => !o)}>{historyOpen ? 'Hide history' : 'History'}</button>
        <button type="button" className="btn-ghost" onClick={() => setInspectorOpen(true)}>Advanced ▾</button>
      </div>

      {historyOpen && (
        <section className="manage-card" aria-label="History">
          <h2 className="subhead" style={{ marginTop: 0 }}>History</h2>
          {detail.releases.length === 0 && <p className="manage-card-blurb">Nothing published yet.</p>}
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '.5rem' }}>
            {[...detail.releases].reverse().map((r) => (
              <li key={r.releaseId} style={{ borderLeft: '3px solid var(--c-g200)', paddingLeft: '.6rem' }}>
                <div style={{ fontSize: '.82rem', fontWeight: 700 }}>
                  Version {r.releaseNumber} · {r.state}
                  {r.smartAgentBinding && <Chip tone="good" style={{ marginLeft: '.4rem' }}>custodian-signed</Chip>}
                </div>
                <div className="manage-card-blurb" style={{ margin: 0 }}>
                  created {new Date(r.createdAt).toLocaleString()}
                  {r.publication && <> · published {new Date(r.publication.publishedAt).toLocaleString()} at <a href={r.publication.uri} target="_blank" rel="noreferrer">{r.publication.uri}</a></>}
                </div>
                <details style={{ fontSize: '.7rem', marginTop: '.2rem' }}>
                  <summary>Audit detail</summary>
                  <div style={{ wordBreak: 'break-all' }}>
                    id {r.releaseId} · unsigned {r.unsignedContentDigest}{r.signedContentDigest ? ` · signed ${r.signedContentDigest}` : ''}
                    {r.approvals.map((a) => <div key={a.approvalId}>approved by {a.approver} at {a.approvedAt}</div>)}
                    {r.revocation && <div>revoked: {r.revocation.reason} ({r.revocation.revokedAt})</div>}
                  </div>
                </details>
                {r.state === 'published' && (
                  <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center', marginTop: '.3rem', flexWrap: 'wrap' }}>
                    <BusyButton busy={historyBusy === `dep-${r.releaseId}`} busyLabel="Retiring…" className="btn-ghost" onClick={() => { setHistoryBusy(`dep-${r.releaseId}`); void deprecateRelease(delegation, detail.resource.cardResourceId, r.releaseId, newMutation()).then(() => { notifyCardChanged(); onReload(); }).catch((e) => setError(studioErrorSentence(String(e)))).finally(() => setHistoryBusy(null)); }}>Retire this version</BusyButton>
                    <input placeholder="Reason (required to withdraw)" value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} style={{ ...inputStyle, maxWidth: 260 }} />
                    <BusyButton busy={historyBusy === `rev-${r.releaseId}`} busyLabel="Withdrawing…" className="btn-ghost" disabled={!revokeReason.trim()} onClick={() => { setHistoryBusy(`rev-${r.releaseId}`); void revokeRelease(delegation, detail.resource.cardResourceId, r.releaseId, { ...newMutation(), reason: revokeReason.trim() }).then(() => { notifyCardChanged(); onReload(); }).catch((e) => setError(studioErrorSentence(String(e)))).finally(() => setHistoryBusy(null)); }}>Withdraw</BusyButton>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      <Inspector
        delegation={delegation}
        draft={draft}
        previousRelease={latest}
        diagnostics={validation?.diagnostics ?? []}
        projections={projections}
        latestReleaseId={latest?.releaseId ?? null}
        pendingNewRelease={draftChanged}
        proposals={[]}
        busy={busy !== null}
        onGoToField={(pointer) => { setInspectorOpen(false); setEditorPointer(pointer); setEditing(true); }}
        onAcceptProposal={() => undefined}
        onRejectProposal={() => undefined}
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        panel={panel}
        onPanelChange={setPanel}
      />
    </div>
  );
}
