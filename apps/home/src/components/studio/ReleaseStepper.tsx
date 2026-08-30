'use client';
// The release flow (design §6): validate → create release → request approval → approve → sign → publish →
// verify. Each node shows where the release IS, who moved it, and — when the viewer can't perform the
// current step — the muted "Waiting on someone with … access." line instead of a button. Separation of
// duties is VISIBLE here, not just enforced server-side.
import { useCallback, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { buildStudioApprovalCard, approvalCoversSubject, VERSION_LABELS, type StudioApprovalSubjectV1 } from '@agenticprimitives/home';
import type { A2AAgentCardReleaseV1, CardDraftState } from '@agenticprimitives/agent-profile/a2a';
import { signedCardContentDigest } from '@agenticprimitives/agent-profile/a2a';
import { BusyButton } from '../shared/BusyButton';
import { AddressChip } from '../shared/AddressChip';
import {
  approveRelease,
  buildSmartAgentBinding,
  createRelease,
  deprecateRelease,
  newCardSigningKey,
  newMutation,
  publishRelease,
  requestReleaseApproval,
  revokeRelease,
  signRelease,
  signReleaseLocally,
  signSmartAgentBinding,
  verifyReleasePublication,
  type CardDetail,
  type DelegationWire,
  type ReleaseSignature,
  type SignHash,
} from '../../studio-client';
import { CHAIN_ID } from '../../lib/chain';
import { A2A_DOMAIN, AGENT_NAME_PARENT } from '../../lib/domain';
import { cardUriForName, editForksNewDraft, gateForOp, stepperSteps, STEP_OP, type StepId } from '../../lib/studio-view';
import { ReleaseDiffPanel } from './Inspector';
import { Banner, Chip, Digest, ErrorLine, LiveRegion, inputStyle } from './ui';
import { notifyCardChanged } from './useStudio';

/**
 * A LOCAL render envelope for `buildStudioApprovalCard` — the package owns the title/summary/digest
 * truncation and we never hand-roll it (design §14). This envelope is never persisted, transmitted, or
 * treated as authority: the approval that counts is the `ApprovalRefV1` the service mints, which names the
 * exact digest shown here. The `proof` slot carries no signature because this half carries none.
 */
function approvalRender(subject: StudioApprovalSubjectV1, agent: string) {
  return buildStudioApprovalCard(subject, {
    cardId: `local:${subject.objectId}`,
    interactionId: `local:${subject.objectId}`,
    dataRefs: [],
    allowedActions: [
      { actionId: 'approve', label: 'Approve', transition: 'approve', style: 'primary' },
      { actionId: 'reject', label: 'Reject', transition: 'deny', style: 'destructive' },
    ],
    uiProfile: 'agenticprimitives-card-v1',
    proof: { signer: agent as StudioApprovalSubjectV1['agent'], scheme: 'erc1271', signature: '0x' },
  });
}

/** RFC 7638 thumbprint the JWS was signed under — it travels in the protected header as `kid`. */
function decodeKid(protectedHeader: string): string {
  const json = atob(protectedHeader.replace(/-/g, '+').replace(/_/g, '/'));
  const kid = (JSON.parse(json) as { kid?: string }).kid;
  if (!kid) throw new Error('the prepared card signature carries no kid');
  return kid;
}

function StepNode({ label, state, muted }: { label: string; state: 'done' | 'current' | 'todo'; muted?: string }) {
  return (
    <li style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '.2rem', flex: 1, minWidth: 76 }}>
      <span
        aria-hidden
        style={{
          width: 12,
          height: 12,
          borderRadius: 999,
          background: state === 'done' ? 'var(--c-primary)' : 'transparent',
          border: state === 'todo' ? '2px solid var(--c-g300)' : '2px solid var(--c-primary)',
        }}
      />
      <span style={{ fontSize: '.68rem', fontWeight: state === 'current' ? 700 : 500, color: state === 'todo' ? 'var(--c-g400)' : 'var(--c-g700)', textAlign: 'center' }}>
        {label}
        {state === 'current' && <span className="sr-only"> (current step)</span>}
      </span>
      {muted && (
        <span style={{ fontSize: '.65rem', color: 'var(--c-g500)', textAlign: 'center' }}>{muted}</span>
      )}
    </li>
  );
}

export function ReleaseStepper({
  delegation,
  detail,
  release,
  draftState,
  sa,
  agentName,
  scopes,
  signHashFor,
  onReload,
  autoExpand,
}: {
  delegation: DelegationWire;
  detail: CardDetail;
  release: A2AAgentCardReleaseV1 | null;
  draftState: CardDraftState | null;
  sa: Address;
  agentName: string;
  scopes: readonly string[];
  signHashFor(): Promise<SignHash>;
  onReload(): void;
  autoExpand?: boolean;
}) {
  const [busy, setBusy] = useState<StepId | 'deprecate' | 'revoke' | null>(null);
  const [step, setStep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [signOpen, setSignOpen] = useState(!!autoExpand);
  const [cardUri, setCardUri] = useState(() => cardUriForName(agentName, { nameParent: AGENT_NAME_PARENT, a2aDomain: A2A_DOMAIN }) ?? '');
  const [revokeReason, setRevokeReason] = useState('');
  const [publishNote, setPublishNote] = useState<{ tone: 'good' | 'warn'; text: string } | null>(null);
  /** The JWS produced in THIS browser, held until the steward chooses how to attach it (see §6.2 below). */
  const [prepared, setPrepared] = useState<ReleaseSignature | null>(null);

  const steps = useMemo(() => stepperSteps({ draftState, release }), [draftState, release]);
  const cardResourceId = detail.resource.cardResourceId;

  const run = useCallback(
    async (id: StepId | 'deprecate' | 'revoke', label: string, fn: () => Promise<void>) => {
      setBusy(id);
      setStep(label);
      setError(null);
      try {
        await fn();
        notifyCardChanged();
        onReload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
        setStep('');
      }
    },
    [onReload],
  );

  const approvalSubject: StudioApprovalSubjectV1 | null = release
    ? {
        agent: `eip155:${CHAIN_ID}:${sa}` as StudioApprovalSubjectV1['agent'],
        kind: 'card-release',
        objectId: release.releaseId,
        digest: release.unsignedContentDigest,
      }
    : null;
  const approvalCard = approvalSubject ? approvalRender(approvalSubject, `eip155:${CHAIN_ID}:${sa}`) : null;
  const standingApproval = release?.approvals?.[release.approvals.length - 1] ?? null;
  const approvalCovers = standingApproval && approvalSubject ? approvalCoversSubject(standingApproval, approvalSubject, new Date().toISOString()) : null;

  const gate = (id: StepId) => gateForOp(scopes, STEP_OP[id]);

  return (
    <div className="manage-card">
      <LiveRegion message={step} />
      <ol style={{ display: 'flex', listStyle: 'none', margin: '0 0 .8rem', padding: 0, gap: '.3rem', flexWrap: 'wrap' }}>
        {steps.map((s) => (
          <StepNode
            key={s.id}
            label={s.label}
            state={s.state}
            muted={s.state === 'current' && !gate(s.id).allowed ? gate(s.id).reason : undefined}
          />
        ))}
      </ol>

      {release && (
        <p className="manage-card-blurb" style={{ margin: '0 0 .5rem' }}>
          {VERSION_LABELS.cardRelease} {release.releaseNumber} · <Chip tone={release.state === 'published' ? 'good' : 'muted'}>{release.state}</Chip>{' '}
          <Digest value={release.signedContentDigest ?? release.unsignedContentDigest} /> · {VERSION_LABELS.agentVersion}: {release.agentVersion}
        </p>
      )}

      {release && editForksNewDraft(release.state) && (
        <Banner tone="muted">
          This release is already {release.state}. Editing starts a new draft — the current release stays exactly as
          it is.
        </Banner>
      )}

      <ErrorLine error={error} />
      {publishNote && <Banner tone={publishNote.tone}>{publishNote.text}</Banner>}

      <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
        {/* 2 — Create release. The diff IS the confirmation step; never a silent snapshot. The trigger HIDES
            while that panel is open: two identically-labelled buttons on screen read as the app asking twice. */}
        {!confirmRelease && (!release || !['validated', 'approvalPending', 'approved', 'signed'].includes(release.state)) && detail.draft && (
          <BusyButton
            busy={busy === 'create-release'}
            busyLabel="Creating release…"
            className="btn-primary"
            disabled={!gate('create-release').allowed || draftState !== 'validated'}
            title={!gate('create-release').allowed ? gate('create-release').reason : draftState !== 'validated' ? 'Validate the draft first — a release is only cut from a clean, validated draft.' : undefined}
            onClick={() => setConfirmRelease(true)}
          >
            Create release
          </BusyButton>
        )}

        {/* 3 — Request approval. */}
        {release?.state === 'validated' && (
          <BusyButton
            busy={busy === 'request-approval'}
            busyLabel="Requesting…"
            className="btn-primary"
            disabled={!gate('request-approval').allowed}
            title={gate('request-approval').reason}
            onClick={() =>
              void run('request-approval', 'Requesting approval…', async () => {
                await requestReleaseApproval(delegation, cardResourceId, release.releaseId, newMutation());
              })
            }
          >
            Request approval
          </BusyButton>
        )}

        {/* 4 — Approve. */}
        {release?.state === 'approvalPending' && (
          <BusyButton
            busy={busy === 'approve'}
            busyLabel="Approving…"
            className="btn-primary"
            disabled={!gate('approve').allowed}
            title={gate('approve').reason}
            onClick={() =>
              void run('approve', 'Approving…', async () => {
                await approveRelease(delegation, cardResourceId, release.releaseId, newMutation());
              })
            }
          >
            Approve this release
          </BusyButton>
        )}

        {/* 5 — Sign (two signatures, §6.2). */}
        {release?.state === 'approved' && (
          <button type="button" className="btn-primary" disabled={!gate('sign').allowed} title={gate('sign').reason} onClick={() => setSignOpen((o) => !o)}>
            Sign this release
          </button>
        )}

        {/* 6 — Publish, staying busy through the verify re-fetch. */}
        {release?.state === 'signed' && (
          <BusyButton
            busy={busy === 'publish'}
            busyLabel={step || 'Publishing…'}
            className="btn-primary"
            disabled={!gate('publish').allowed}
            title={gate('publish').reason}
            onClick={() =>
              void run('publish', 'Publishing…', async () => {
                const res = await publishRelease(delegation, cardResourceId, release.releaseId, newMutation());
                setStep('Verifying…');
                setPublishNote(
                  res.receipt.verificationResult === 'valid'
                    ? { tone: 'good', text: "Live and verified — this is the card your agent's endpoint is actually serving." }
                    : { tone: 'warn', text: "Published, but we couldn't confirm your agent's endpoint is serving it yet. This usually resolves within a minute." },
                );
              })
            }
          >
            Publish to your agent&rsquo;s endpoint
          </BusyButton>
        )}

        {/* 7 — Verify (re-run the well-known check). */}
        {release && (release.state === 'signed' || release.state === 'published') && (
          <BusyButton
            busy={busy === 'verify'}
            busyLabel="Checking…"
            className="btn-ghost"
            disabled={!gate('verify').allowed}
            title={gate('verify').reason}
            onClick={() =>
              void run('verify', 'Verifying…', async () => {
                const res = await verifyReleasePublication(delegation, cardResourceId, release.releaseId);
                setPublishNote(
                  res.receipt.verificationResult === 'valid'
                    ? { tone: 'good', text: "Live and verified — this is the card your agent's endpoint is actually serving." }
                    : { tone: 'warn', text: `Still unconfirmed (${res.receipt.verificationResult}). ${res.receipt.detail ?? ''}` },
                );
              })
            }
          >
            Check again
          </BusyButton>
        )}

        {release?.state === 'published' && (
          <>
            <BusyButton
              busy={busy === 'deprecate'}
              busyLabel="Deprecating…"
              className="btn-ghost"
              disabled={!gateForOp(scopes, 'release.deprecate').allowed}
              title={gateForOp(scopes, 'release.deprecate').reason}
              onClick={() =>
                void run('deprecate', 'Deprecating…', async () => {
                  await deprecateRelease(delegation, cardResourceId, release.releaseId, newMutation());
                })
              }
            >
              Deprecate
            </BusyButton>
            <div style={{ display: 'flex', gap: '.35rem', alignItems: 'center' }}>
              <input aria-label="Reason for revoking" placeholder="Reason (required to revoke)" value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} style={{ ...inputStyle, width: 240 }} />
              <BusyButton
                busy={busy === 'revoke'}
                busyLabel="Revoking…"
                className="btn-danger-outline"
                disabled={!revokeReason.trim() || !gateForOp(scopes, 'release.revoke').allowed}
                title={gateForOp(scopes, 'release.revoke').reason}
                onClick={() =>
                  void run('revoke', 'Revoking…', async () => {
                    await revokeRelease(delegation, cardResourceId, release.releaseId, { ...newMutation(), reason: revokeReason.trim() });
                    setRevokeReason('');
                  })
                }
              >
                Revoke
              </BusyButton>
            </div>
          </>
        )}
      </div>

      {/* Create-release confirmation: the release diff, shown before anything is frozen. This panel IS step 2
          in progress — it replaces its own trigger rather than sitting beside it. */}
      {confirmRelease && detail.draft && (
        <div style={{ marginTop: '.8rem', border: '1px solid var(--c-primary)', borderRadius: 8, padding: '.7rem' }}>
          <h3 className="subhead" style={{ marginTop: 0 }}>
            Review, then freeze: what this {VERSION_LABELS.cardRelease.toLowerCase()} changes
          </h3>
          <ReleaseDiffPanel previous={release} draft={detail.draft} />
          <div style={{ display: 'flex', gap: '.4rem', marginTop: '.6rem' }}>
            <BusyButton
              busy={busy === 'create-release'}
              busyLabel="Creating release…"
              className="btn-primary"
              onClick={() =>
                void run('create-release', 'Creating release…', async () => {
                  await createRelease(delegation, cardResourceId, newMutation());
                  setConfirmRelease(false);
                })
              }
            >
              Create release
            </BusyButton>
            <button type="button" className="btn-ghost" onClick={() => setConfirmRelease(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* The approval card — the render half naming the EXACT digest an approver signs off on. */}
      {approvalCard && release && (release.state === 'approvalPending' || release.state === 'approved') && (
        <div style={{ marginTop: '.8rem', border: '1px solid var(--c-g200)', borderRadius: 8, padding: '.7rem' }}>
          <div style={{ fontSize: '.82rem', fontWeight: 700 }}>{approvalCard.title}</div>
          <div className="manage-card-blurb">{approvalCard.summary}</div>
          <div style={{ margin: '.35rem 0' }}>
            <AddressChip address={sa} size="sm" />
          </div>
          {standingApproval && (
            <p className="manage-card-blurb" style={{ margin: 0 }}>
              Approved by <code>{standingApproval.approver}</code> at {standingApproval.approvedAt}.
              {approvalCovers && !approvalCovers.ok && (
                <b style={{ color: 'var(--c-danger)' }}>
                  {' '}
                  This release changed since approval was requested — request approval again.
                </b>
              )}
            </p>
          )}
        </div>
      )}

      {/* §6.2 — the two signatures, explained plainly.
          SERVICE SHAPE: `release.sign` attaches a JWS and (optionally) the Smart Agent binding in ONE call —
          it refuses a call that carries no new signature — so a binding cannot be bolted onto an
          already-signed release later. The two decisions therefore stay two explicit steps, but ① PREPARES
          the JWS in the browser and the step the steward finishes with is the one that submits. Nothing is
          collapsed: a card signature alone is one button, a card signature + binding is the other. */}
      {signOpen && release && (release.state === 'approved' || release.state === 'signed') && (
        <div style={{ marginTop: '.8rem', border: '1px solid var(--c-g200)', borderRadius: 8, padding: '.7rem' }}>
          <h3 className="subhead" style={{ marginTop: 0 }}>
            Sign this release
          </h3>

          <div style={{ marginBottom: '.7rem' }}>
            <div style={{ fontSize: '.82rem', fontWeight: 700 }}>① Card signature — proves nobody tampered with it</div>
            <p className="manage-card-blurb">Any A2A client can check this. Required for every card.</p>
            <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
              <BusyButton
                busy={busy === 'sign' && step.startsWith('Signing')}
                busyLabel="Signing…"
                className="btn-primary"
                disabled={!!prepared || release.signatures.length > 0 || !gate('sign').allowed}
                title={release.signatures.length > 0 ? 'This release already carries a card signature.' : gate('sign').reason}
                onClick={() =>
                  void run('sign', 'Signing…', async () => {
                    const key = await newCardSigningKey();
                    setPrepared(await signReleaseLocally(release, key));
                  })
                }
              >
                Sign card
              </BusyButton>
              {prepared && (
                <BusyButton
                  busy={busy === 'sign' && step.startsWith('Attaching')}
                  busyLabel="Attaching…"
                  className="btn-ghost"
                  onClick={() =>
                    void run('sign', 'Attaching the card signature…', async () => {
                      await signRelease(delegation, cardResourceId, release.releaseId, prepared, newMutation());
                      setPrepared(null);
                    })
                  }
                >
                  Attach without binding
                </BusyButton>
              )}
            </div>
            {prepared && release.signatures.length === 0 && (
              <p className="manage-card-blurb" style={{ margin: '.3rem 0 0' }}>
                Card signature prepared in this browser. Attach it on its own, or bind it to your Smart Agent below —
                either way it is attached in one call.
              </p>
            )}
            {release.signatures.length > 0 && (
              <p className="manage-card-blurb" style={{ margin: '.3rem 0 0', color: 'var(--color-sage-700)' }}>
                Signed ✓ · card signature{release.smartAgentBinding ? ' + Smart Agent binding' : ''} ·{' '}
                {release.signatures[0]?.signedAt ?? ''}
              </p>
            )}
          </div>

          <div>
            <div style={{ fontSize: '.82rem', fontWeight: 700 }}>② Smart Agent binding — proves YOUR agent authorized it</div>
            <p className="manage-card-blurb">
              Only needed by verifiers that check Agentic Primitives identity — most A2A clients skip this and are
              still fine.
            </p>
            <label style={{ display: 'block', fontSize: '.72rem', color: 'var(--c-g500)', margin: '.3rem 0 .15rem' }} htmlFor="studio-card-uri">
              Card URI this binding names
            </label>
            <input id="studio-card-uri" value={cardUri} onChange={(e) => setCardUri(e.target.value)} style={inputStyle} />
            <BusyButton
              busy={busy === 'sign' && step.startsWith('Binding')}
              busyLabel="Binding to your Smart Agent…"
              className="btn-primary"
              style={{ marginTop: '.4rem' }}
              disabled={!prepared || !cardUri.trim() || !gate('sign').allowed}
              title={
                release.smartAgentBinding
                  ? 'This release is already bound to the Smart Agent.'
                  : !prepared
                    ? 'Prepare the card signature first — the binding names the signed card’s digest.'
                    : gate('sign').reason
              }
              onClick={() =>
                void run('sign', 'Binding to your Smart Agent…', async () => {
                  if (!prepared) throw new Error('prepare the card signature first');
                  const kid = decodeKid(prepared.signature.protected);
                  const binding = buildSmartAgentBinding({
                    chainId: CHAIN_ID,
                    sa,
                    release,
                    signedCardDigest: signedCardContentDigest(prepared.signedCard),
                    cardUri: cardUri.trim(),
                    kid,
                  });
                  const signHash = await signHashFor();
                  const signed = await signSmartAgentBinding(sa, CHAIN_ID, signHash, binding);
                  await signRelease(delegation, cardResourceId, release.releaseId, { ...prepared, smartAgentBinding: signed }, newMutation());
                  setPrepared(null);
                })
              }
            >
              Bind to Smart Agent
            </BusyButton>
            {release.smartAgentBinding && (
              <p className="manage-card-blurb" style={{ margin: '.3rem 0 0', color: 'var(--color-sage-700)' }}>
                Bound ✓ · this exact release is authorized by the Smart Agent.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
