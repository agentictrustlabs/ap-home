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
  patchDraft,
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
import { CHAIN_ID } from '../../lib/chain';
import { A2A_DOMAIN, AGENT_NAME_PARENT } from '../../lib/domain';
import { Stage, TONE_COLOR, decodeKid, typedNameOf, useUrlFlag } from './parts';
import { BINDING_PROMPT, PUBLISH_PHRASE, describeStage, publicEndpoints, liveStage, onlyAddressProblems, planPublish, problemsFrom, servedInterfacesFrom, type PublishPlan, type StageStatus } from '../../lib/studio-flow';
import { CardEditor } from './CardEditor';
import { Inspector, type PanelId } from './Inspector';
import { ReleaseStepper } from './ReleaseStepper';
import { Banner, Chip, ErrorLine, LiveRegion, inputStyle } from './ui';
import { notifyCardChanged, useCanSignFor } from './useStudio';

export function AgentCardFlow({
  delegation, detail, projections, scopes, sa, agentName, basePath, signHashFor, onDetail, onReload,
  initialPointer, initialDiagnostic, initialPanel, staleBanner,
}: {
  delegation: DelegationWire;
  detail: CardDetail;
  projections: readonly StoredProjection[];
  scopes: readonly string[];
  sa: Address;
  agentName: string;
  /** `…/card/<id>` — the flow links to its sibling tabs from here. */
  basePath: string;
  signHashFor(): Promise<SignHash>;
  onDetail(next: CardDetail): void;
  onReload(): void;
  initialPointer?: string | null;
  initialDiagnostic?: string | null;
  initialPanel?: PanelId | null;
  staleBanner?: boolean;
}) {
  const [editing, setEditing] = useUrlFlag('edit');
  // Stewardship runs the Studio; only a CUSTODIAN can sign for the agent's account on chain (listings, the
  // optional binding). Known before any click so the page never offers an act that will be refused.
  const canSign = useCanSignFor(sa);
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
  const typedName = typedNameOf(detail, agentName);
  const cardUri = useMemo(() => cardUriForName(typedName, { nameParent: AGENT_NAME_PARENT, a2aDomain: A2A_DOMAIN }), [typedName]);

  const problems = problemsFrom(validation?.diagnostics ?? []);
  const served = servedInterfacesFrom(validation?.diagnostics ?? []);
  const addressOnly = onlyAddressProblems(validation?.diagnostics ?? []);
  const [fixing, setFixing] = useState(false);
  const useServedAddress = useCallback(async () => {
    if (!draft || served.length === 0) return;
    setFixing(true); setError(null);
    try {
      const next = await patchDraft(delegation, detail.resource.cardResourceId, [{ op: 'replace', path: '/supportedInterfaces', value: served.map((i) => ({ url: i.url, protocolBinding: i.protocolBinding, protocolVersion: '1.0' })) }], { ...newMutation(), expectedRevision: draft.revision });
      onDetail({ ...detail, draft: next.draft });
      lastCheckedRevision.current = null;
    } catch (e) {
      setError(studioErrorSentence(e instanceof Error ? e.message : String(e)));
    } finally {
      setFixing(false);
    }
  }, [draft, served, delegation, detail, onDetail]);

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
          if (bindingUri.trim() && canSign !== false) {
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

  const listingsHref = `${basePath}/listing/ap-naming`;
  const [inspectorOpen, setInspectorOpen] = useState(!!initialPanel);
  const [panel, setPanel] = useState<PanelId>(initialPanel ?? (A2A_CARD_EDITOR_MANIFEST.inspectorPanels[0] as PanelId));
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
          diagnostics={validation?.diagnostics ?? []}
        />
      </div>
    );
  }

  const name = draft?.card.name || agentName || 'this agent';
  const description = draft?.card.description ?? '';
  return (
    <div>
      <LiveRegion message={phase} />
      <p className="manage-card-blurb" style={{ margin: '0 0 .8rem' }}>
        This is what other agents see when they look <b>{name}</b> up. Describe it, then make it live at its
        public address. Listing it where agents search is the next tab.
      </p>

      <Stage n="①" title="Describe your agent" status={{ tone: describe.tone, text: checking ? 'Checking…' : describe.status }}>
        <p className="manage-card-blurb" style={{ margin: '0 0 .4rem' }}>{describe.body}</p>
        {description && <p style={{ fontSize: '.85rem', margin: '0 0 .5rem', color: 'var(--c-g700)' }}>&ldquo;{description.length > 180 ? `${description.slice(0, 180)}…` : description}&rdquo;</p>}
        {problems.length > 0 && (
          <ul style={{ listStyle: 'none', margin: '0 0 .6rem', padding: 0, display: 'grid', gap: '.35rem' }}>
            {problems.map((p, i) => (
              <li key={`${p.pointer ?? 'x'}-${i}`} style={{ borderLeft: `3px solid ${TONE_COLOR.warn}`, paddingLeft: '.5rem', fontSize: '.82rem' }}>
                {p.where && <b>{p.where}: </b>}
                {p.message}
                {p.pointer && (
                  <>
                    {' '}
                    <button type="button" className="btn-ghost" style={{ minHeight: 28, padding: '.1rem .4rem', fontSize: '.72rem' }} onClick={() => { setEditorPointer(p.pointer!); setEditing(true); }}>
                      Fix this
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {addressOnly && served.length > 0 && (
          <div style={{ marginBottom: '.6rem' }}>
            <p className="manage-card-blurb" style={{ margin: '0 0 .3rem' }}>
              The card names an address this agent no longer serves. It now answers at <b>{served[0]!.url}</b> — that
              usually means it moved. Updating the card to match is safe: it changes nothing in public until you publish.
            </p>
            <BusyButton busy={fixing} busyLabel="Updating…" className="btn-primary" onClick={() => void useServedAddress()}>
              Use the address it serves
            </BusyButton>
          </div>
        )}
        <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
          {describe.action?.id === 'show-problems' && (
            <button type="button" className="btn-ghost" onClick={() => { setEditorPointer(problems[0]?.pointer ?? null); setEditorDiagnostic(validation?.diagnostics.find((d) => d.severity === 'error')?.code ?? null); setEditing(true); }}>
              Open the editor
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
              <button type="button" className="btn-ghost" onClick={() => { setEditorPointer(problems[0]?.pointer ?? null); setEditing(true); }}>Open the editor</button>
            </>
          )}
        </div>
        {plan.kind === 'live' && (
          <div style={{ marginTop: '.6rem', display: 'grid', gap: '.4rem' }}>
            <span className="manage-card-blurb" style={{ margin: 0, fontWeight: 700 }}>What this address serves</span>
            {publicEndpoints(cardUri).map((e) => (
              <div key={e.id} style={{ border: '1px solid var(--c-g200)', borderRadius: 8, padding: '.5rem .6rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '.6rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 700, fontSize: '.82rem' }}>{e.label}</span>
                  <a href={e.standardUrl} target="_blank" rel="noreferrer" style={{ fontSize: '.7rem', color: 'var(--c-g500)' }}>
                    follows {e.standard} ↗
                  </a>
                </div>
                <p className="manage-card-blurb" style={{ margin: '.1rem 0 .3rem' }}>{e.what}</p>
                <a href={e.url} target="_blank" rel="noreferrer" style={{ fontSize: '.72rem', wordBreak: 'break-all', color: 'var(--c-primary)', fontWeight: 600 }}>
                  {e.url} ↗
                </a>
              </div>
            ))}
          </div>
        )}
      </Stage>

      {plan.kind === 'live' && (
        <p className="manage-card-blurb" style={{ margin: '0 0 .8rem' }}>
          Published. Now list it where agents and people search —{' '}
          <a href={listingsHref} style={{ color: 'var(--c-primary)', fontWeight: 600 }}>go to Your name record →</a>
        </p>
      )}

      <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', margin: '.4rem 0 .8rem' }}>
        <button type="button" className="btn-ghost" onClick={() => setInspectorOpen(true)}>Advanced ▾</button>
      </div>
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