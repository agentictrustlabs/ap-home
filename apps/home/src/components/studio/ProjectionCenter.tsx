'use client';
// The projection center (design §8): one row per configured target, the loss report in plain language, the
// plan review that discloses what/how-much/whose-credential/how-long before any approval exists, and the
// custodian execution that is the moment a transaction actually happens.
import { useCallback, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { ExternalIdentityBindingV1 } from '@agenticprimitives/registry-kit/projection';
import { VERSION_LABELS } from '@agenticprimitives/home';
import { BusyButton } from '../shared/BusyButton';
import {
  approveProjectionPublication,
  configureProjection,
  executeNamingPlan,
  executePublicationPlan,
  newMutation,
  planProjectionPublication,
  previewProjection,
  requestProjectionApproval,
  type CardDetail,
  type DelegationWire,
  type PlannedPublication,
  type ProjectionPreview,
  type SignHash,
  type StoredProjection,
  type StudioFamily,
} from '../../studio-client';
import { CONTRACTS } from '../../lib/chain';
import { DRIFT_COPY, gateForOp, gateForPublish, lossLead, projectionRowFrom, targetLabel } from '../../lib/studio-view';
import { Banner, Chip, Digest, ErrorLine, LiveRegion, inputStyle } from './ui';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { notifyCardChanged } from './useStudio';

const STATE_TONE: Record<string, 'good' | 'warn' | 'danger' | 'muted'> = {
  unconfigured: 'muted',
  configured: 'muted',
  ready: 'muted',
  generated: 'muted',
  approvalPending: 'warn',
  publishing: 'warn',
  published: 'good',
  drifted: 'danger',
  failed: 'danger',
  stale: 'warn',
  retired: 'muted',
};

interface RowWork {
  preview?: ProjectionPreview;
  planned?: PlannedPublication;
  approvalId?: string;
}

function PublicationPlanReview({ planned, onRequest, busy, gateReason }: { planned: PlannedPublication; onRequest(): void; busy: boolean; gateReason?: string }) {
  const { plan } = planned;
  const cost = plan.operations.map((o) => o.estimatedCost).find((c) => !!c);
  const credential = plan.credentialRefs[0];
  return (
    <div style={{ border: '1px solid var(--c-g200)', borderRadius: 8, padding: '.65rem', marginTop: '.5rem' }}>
      <div style={{ fontSize: '.82rem', fontWeight: 700, marginBottom: '.3rem' }}>Review before requesting approval</div>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '.15rem .6rem', margin: 0, fontSize: '.76rem' }}>
        <dt style={{ color: 'var(--c-g500)' }}>Target</dt>
        <dd style={{ margin: 0 }}>
          {targetLabel(plan.target.family)}
          {plan.target.registry ? ` · ${plan.target.registry}` : ''}
        </dd>
        <dt style={{ color: 'var(--c-g500)' }}>Operations</dt>
        <dd style={{ margin: 0 }}>
          <ul style={{ margin: 0, paddingLeft: '1rem' }}>
            {plan.operations.map((o, i) => (
              <li key={`${o.kind}-${i}`}>
                {o.kind} → <code style={{ fontSize: '.72rem' }}>{o.target}</code>
              </li>
            ))}
          </ul>
        </dd>
        <dt style={{ color: 'var(--c-g500)' }}>Estimated cost</dt>
        <dd style={{ margin: 0 }}>{cost ? `${cost.amount} ${cost.asset}` : 'not estimated by this plan'}</dd>
        <dt style={{ color: 'var(--c-g500)' }}>Ceiling</dt>
        <dd style={{ margin: 0 }}>{plan.costCeiling ? `${plan.costCeiling.amount} ${plan.costCeiling.asset}` : 'no ceiling on this plan'}</dd>
        <dt style={{ color: 'var(--c-g500)' }}>Credential</dt>
        <dd style={{ margin: 0 }}>{credential ? `${credential.keyId} (${credential.backend}${credential.kind ? `, ${credential.kind}` : ''})` : 'your Smart Agent’s custodian'}</dd>
        <dt style={{ color: 'var(--c-g500)' }}>Expires</dt>
        <dd style={{ margin: 0 }}>{plan.expiresAt}</dd>
        <dt style={{ color: 'var(--c-g500)' }}>Plan digest</dt>
        <dd style={{ margin: 0 }}>
          <Digest value={plan.planDigest} />
        </dd>
      </dl>
      <BusyButton busy={busy} busyLabel="Requesting…" className="btn-primary" style={{ marginTop: '.5rem' }} disabled={!!gateReason} title={gateReason} onClick={onRequest}>
        Request approval
      </BusyButton>
    </div>
  );
}

export function ProjectionCenter({
  delegation,
  detail,
  projections,
  bindings,
  scopes,
  sa,
  signHashFor,
  onReload,
  focusInstance,
}: {
  delegation: DelegationWire;
  detail: CardDetail;
  projections: StoredProjection[];
  bindings: readonly ExternalIdentityBindingV1[];
  scopes: readonly string[];
  sa: Address;
  signHashFor(): Promise<SignHash>;
  onReload(): void;
  focusInstance?: string | null;
}) {
  const [work, setWork] = useState<Record<string, RowWork>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [step, setStep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<StudioFamily | null>(null);
  const [registry, setRegistry] = useState<string>(CONTRACTS.agentRegistryBase ?? '');
  const [registryId, setRegistryId] = useState('urn:ap:registry:');

  const releases = detail.releases.filter((r) => r.state === 'signed' || r.state === 'published');
  const [releaseId, setReleaseId] = useState(releases[releases.length - 1]?.releaseId ?? '');
  const latestReleaseDigest = detail.releases[detail.releases.length - 1]?.signedContentDigest ?? detail.releases[detail.releases.length - 1]?.unsignedContentDigest ?? null;

  const run = useCallback(
    async (id: string, label: string, fn: () => Promise<void>) => {
      setBusyId(id);
      setStep(label);
      setError(null);
      try {
        await fn();
        notifyCardChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
        setStep('');
      }
    },
    [],
  );

  const configure = useCallback(
    (family: StudioFamily) =>
      void run(`configure-${family}`, 'Configuring…', async () => {
        await configureProjection(
          delegation,
          {
            family,
            ...(family === 'ap-registry' ? { configuration: { registry: registry as Address, registryId } as never } : {}),
            cardResourceId: detail.resource.cardResourceId,
            ...(releaseId ? { selectedReleaseId: releaseId } : {}),
          },
          newMutation(),
        );
        setConfiguring(null);
        onReload();
      }),
    [delegation, detail.resource.cardResourceId, registry, registryId, releaseId, run, onReload],
  );

  const configuredFamilies = new Set(projections.map((p) => p.family));

  return (
    <div>
      <LiveRegion message={step} />
      <ErrorLine error={error} />

      <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', marginBottom: '.7rem' }}>
        {(['ap-naming', 'ap-registry'] as StudioFamily[])
          .filter((f) => !configuredFamilies.has(f))
          .map((f) => (
            <button
              key={f}
              type="button"
              className="btn-ghost"
              disabled={!gateForOp(scopes, 'projection.configure').allowed}
              title={gateForOp(scopes, 'projection.configure').reason}
              onClick={() => setConfiguring(f)}
            >
              Configure {targetLabel(f)}
            </button>
          ))}
      </div>

      {configuring && (
        <div className="manage-card" style={{ marginBottom: '.8rem' }}>
          <div className="manage-card-head">
            <span className="manage-card-label">Configure {targetLabel(configuring)}</span>
          </div>
          <p className="manage-card-blurb" style={{ margin: '.3rem 0 .5rem' }}>
            A projection consumes a RELEASED card — never a draft. Pick the release this target should reflect.
          </p>
          <label style={{ fontSize: '.72rem', color: 'var(--c-g500)' }} htmlFor="proj-release">
            {VERSION_LABELS.cardRelease}
          </label>
          <select id="proj-release" value={releaseId} onChange={(e) => setReleaseId(e.target.value)} style={inputStyle}>
            <option value="">— none yet —</option>
            {releases.map((r) => (
              <option key={r.releaseId} value={r.releaseId}>
                {VERSION_LABELS.cardRelease} {r.releaseNumber} ({r.state})
              </option>
            ))}
          </select>
          {configuring === 'ap-registry' && (
            <>
              <label style={{ fontSize: '.72rem', color: 'var(--c-g500)', display: 'block', marginTop: '.4rem' }} htmlFor="proj-registry">
                Registry contract
              </label>
              <input id="proj-registry" value={registry} onChange={(e) => setRegistry(e.target.value)} style={inputStyle} />
              <label style={{ fontSize: '.72rem', color: 'var(--c-g500)', display: 'block', marginTop: '.4rem' }} htmlFor="proj-registry-id">
                Registry id
              </label>
              <input id="proj-registry-id" value={registryId} onChange={(e) => setRegistryId(e.target.value)} style={inputStyle} />
            </>
          )}
          <div style={{ display: 'flex', gap: '.4rem', marginTop: '.5rem' }}>
            <BusyButton busy={busyId === `configure-${configuring}`} busyLabel="Configuring…" className="btn-primary" onClick={() => configure(configuring)}>
              Configure
            </BusyButton>
            <button type="button" className="btn-ghost" onClick={() => setConfiguring(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {projections.length === 0 && !configuring && (
        <p className="manage-card-blurb">
          No projection targets configured. A released card stays at your agent&rsquo;s own endpoint until you project
          it somewhere.
        </p>
      )}

      <div className="manage-grid">
        {projections.map((p) => {
          const bound = bindings.find((b) => b.bindingId === p.instance.lastBinding?.bindingId);
          const row = projectionRowFrom(p, { scopes, latestReleaseDigest, ...(bound ? { binding: bound } : {}), losses: work[p.instance.instanceId]?.preview?.result.losses.map((l) => ({ category: l.category, severity: l.severity, explanation: l.explanation })) ?? [] });
          const id = p.instance.instanceId;
          const w = work[id] ?? {};
          const publishGate = gateForPublish(scopes, row.definition.family);
          const drift = row.drift ? DRIFT_COPY[row.drift] : null;
          return (
            <div key={id} className="manage-card" style={focusInstance === id ? { outline: '2px solid var(--c-primary)' } : undefined}>
              <div className="manage-card-head">
                <span className="manage-card-label">{row.definition.displayName}</span>
                <Chip tone={STATE_TONE[row.state] ?? 'muted'}>{row.state}</Chip>
                {row.binding && <Chip tone={row.binding.verification === 'active' ? 'good' : 'warn'}>{row.binding.verification}</Chip>}
              </div>
              <p className="manage-card-blurb" style={{ margin: '.25rem 0' }}>
                {VERSION_LABELS.targetSpecification}: {row.definition.targetSpecification} {row.definition.targetVersion} · {VERSION_LABELS.adapterVersion}: {row.definition.adapterVersion}
              </p>
              <p className="manage-card-blurb" style={{ margin: '.25rem 0' }}>
                {p.selectedCard ? `from ${VERSION_LABELS.cardRelease.toLowerCase()} ${p.selectedCard.releaseId}` : 'no card release selected'}
                {row.digests?.sourceBundle && (
                  <>
                    {' · '}
                    <Digest value={row.digests.sourceBundle} label="bundle" />
                  </>
                )}
              </p>
              {drift && (
                <p className="manage-card-blurb" style={{ margin: '.25rem 0', color: drift.tone === 'danger' ? 'var(--c-danger)' : drift.tone === 'warn' ? 'var(--color-amber-700)' : undefined }}>
                  {drift.line}
                </p>
              )}

              {w.preview && w.preview.result.losses.length > 0 && (
                <details style={{ margin: '.35rem 0' }}>
                  <summary style={{ fontSize: '.76rem', cursor: 'pointer' }}>
                    Losses: {w.preview.result.losses.length} — review what didn&rsquo;t carry over
                  </summary>
                  <ul style={{ listStyle: 'none', margin: '.3rem 0 0', padding: 0 }}>
                    {w.preview.result.losses.map((l, i) => (
                      <li key={i} style={{ fontSize: '.74rem', padding: '.2rem 0' }}>
                        <b>
                          ⚠ {lossLead(l.category)}
                          {l.sourcePointer ? ` · ${l.sourcePointer}` : ''}
                        </b>
                        <div style={{ color: 'var(--c-g700)' }}>{l.explanation}</div>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {w.preview && w.preview.result.requiredActions.length > 0 && (
                <ul style={{ listStyle: 'none', margin: '.3rem 0', padding: 0, fontSize: '.74rem' }}>
                  {w.preview.result.requiredActions.map((a, i) => (
                    <li key={i}>
                      ☐ {a.description}
                      {a.blocking ? ' (blocks publishing)' : ''}
                    </li>
                  ))}
                </ul>
              )}
              {w.preview && w.preview.result.diagnostics.length > 0 && (
                <DiagnosticsPanel diagnostics={w.preview.result.diagnostics} onGoToField={() => undefined} />
              )}

              <div style={{ display: 'flex', gap: '.35rem', flexWrap: 'wrap', marginTop: '.5rem' }}>
                <BusyButton
                  busy={busyId === `preview-${id}`}
                  busyLabel="Previewing…"
                  className="btn-ghost"
                  disabled={!gateForOp(scopes, 'projection.preview').allowed}
                  title={gateForOp(scopes, 'projection.preview').reason}
                  onClick={() =>
                    void run(`preview-${id}`, 'Previewing…', async () => {
                      const preview = await previewProjection(delegation, id);
                      setWork((prev) => ({ ...prev, [id]: { ...prev[id], preview } }));
                      onReload();
                    })
                  }
                >
                  Preview
                </BusyButton>

                <BusyButton
                  busy={busyId === `plan-${id}`}
                  busyLabel="Planning…"
                  className="btn-ghost"
                  disabled={!gateForOp(scopes, 'projection.planPublication').allowed}
                  title={gateForOp(scopes, 'projection.planPublication').reason}
                  onClick={() =>
                    void run(`plan-${id}`, 'Building the publication plan…', async () => {
                      const planned = await planProjectionPublication(delegation, id, newMutation());
                      setWork((prev) => ({ ...prev, [id]: { ...prev[id], planned } }));
                    })
                  }
                >
                  Plan publication
                </BusyButton>

                {w.planned && w.approvalId && (
                  <BusyButton
                    busy={busyId === `publish-${id}`}
                    busyLabel={step || 'Publishing…'}
                    className="btn-primary"
                    disabled={!publishGate.allowed}
                    title={publishGate.reason ?? "This sends the transaction using your Smart Agent's signer — you'll confirm it on your device."}
                    onClick={() =>
                      void run(`publish-${id}`, 'Preparing transaction…', async () => {
                        const planned = w.planned!;
                        setStep('Waiting for your confirmation…');
                        const signHash = await signHashFor();
                        setStep('Publishing…');
                        const exec = planned.plan.target.family === 'ap-naming' ? executeNamingPlan : executePublicationPlan;
                        await exec(sa, signHash, delegation, id, planned, w.approvalId!, newMutation());
                        setStep('Verifying…');
                        setWork((prev) => ({ ...prev, [id]: {} }));
                        onReload();
                      })
                    }
                  >
                    Execute with your custodian
                  </BusyButton>
                )}
              </div>

              {w.planned && !w.approvalId && (
                <>
                  <PublicationPlanReview
                    planned={w.planned}
                    busy={busyId === `request-${id}`}
                    gateReason={gateForOp(scopes, 'projection.requestApproval').reason}
                    onRequest={() =>
                      void run(`request-${id}`, 'Requesting approval…', async () => {
                        await requestProjectionApproval(delegation, id, w.planned!.plan.planId, newMutation());
                        onReload();
                      })
                    }
                  />
                  <BusyButton
                    busy={busyId === `approve-${id}`}
                    busyLabel="Approving…"
                    className="btn-ghost"
                    style={{ marginTop: '.4rem' }}
                    disabled={!gateForOp(scopes, 'projection.approve').allowed}
                    title={gateForOp(scopes, 'projection.approve').reason}
                    onClick={() =>
                      void run(`approve-${id}`, 'Approving the plan…', async () => {
                        const res = await approveProjectionPublication(delegation, id, w.planned!.plan.planId, newMutation());
                        setWork((prev) => ({ ...prev, [id]: { ...prev[id], approvalId: res.approval.approvalId } }));
                        onReload();
                      })
                    }
                  >
                    Approve this plan
                  </BusyButton>
                </>
              )}

              {w.planned && w.approvalId && (
                <Banner tone="muted">
                  Approved plan <Digest value={w.planned.plan.planDigest} /> — publishing sends the transaction with your
                  Smart Agent&rsquo;s signer; you&rsquo;ll confirm it on your device.
                </Banner>
              )}
            </div>
          );
        })}
      </div>

      <p className="manage-card-blurb" style={{ marginTop: '.8rem' }}>
        A remote change is never overwritten from here. If what&rsquo;s out there stops matching what we published, it
        becomes a proposal to review — the remote might be right and the canonical side stale.
      </p>
    </div>
  );
}
