'use client';
// Releases & Audit (design §10): the stepper for whatever release is in flight, then the chronological list
// of every release this card has had — each one immutable, each one naming its own digest, approvals and
// signatures. A release is never edited; it is superseded.
import type { Address } from '@agenticprimitives/types';
import { VERSION_LABELS } from '@agenticprimitives/home';
import type { A2AAgentCardReleaseV1 } from '@agenticprimitives/agent-profile/a2a';
import type { CardDetail, DelegationWire, SignHash } from '../../studio-client';
import { ReleaseStepper } from './ReleaseStepper';
import { Chip, Digest } from './ui';

function ReleaseRow({ r, highlight }: { r: A2AAgentCardReleaseV1; highlight: boolean }) {
  return (
    <div className="manage-card" style={highlight ? { outline: '2px solid var(--c-primary)' } : undefined}>
      <div className="manage-card-head">
        <span className="manage-card-label">
          {VERSION_LABELS.cardRelease} {r.releaseNumber}
        </span>
        <Chip tone={r.state === 'published' ? 'good' : r.state === 'revoked' ? 'danger' : 'muted'}>{r.state}</Chip>
        {r.signatures.length > 0 && <Chip tone="muted">🔒 signed</Chip>}
        {r.smartAgentBinding && <Chip tone="muted">🔗 bound</Chip>}
      </div>
      <p className="manage-card-blurb" style={{ margin: '.25rem 0' }}>
        created {r.createdAt} · {VERSION_LABELS.agentVersion} {r.agentVersion} · {VERSION_LABELS.protocolVersion} {r.protocolVersion}
      </p>
      <p className="manage-card-blurb" style={{ margin: '.15rem 0' }}>
        <Digest value={r.unsignedContentDigest} label="unsigned" />
        {r.signedContentDigest && (
          <>
            {' · '}
            <Digest value={r.signedContentDigest} label="signed" />
          </>
        )}
      </p>
      {r.approvals.map((a) => (
        <p key={a.approvalId} className="manage-card-blurb" style={{ margin: '.15rem 0' }}>
          approved by <code style={{ fontSize: '.72rem' }}>{a.approver}</code> at {a.approvedAt}
        </p>
      ))}
      {r.publication && (
        <p className="manage-card-blurb" style={{ margin: '.15rem 0' }}>
          published {r.publication.publishedAt} at{' '}
          <a href={r.publication.uri} target="_blank" rel="noreferrer">
            {r.publication.uri}
          </a>
        </p>
      )}
      {r.revocation && (
        <p className="manage-card-blurb" style={{ margin: '.15rem 0', color: 'var(--c-danger)' }}>
          revoked {r.revocation.revokedAt} — {r.revocation.reason}
        </p>
      )}
    </div>
  );
}

export function ReleasesAndAudit({
  delegation,
  detail,
  scopes,
  sa,
  agentName,
  signHashFor,
  onReload,
  focusRelease,
}: {
  delegation: DelegationWire;
  detail: CardDetail;
  scopes: readonly string[];
  sa: Address;
  agentName: string;
  signHashFor(): Promise<SignHash>;
  onReload(): void;
  focusRelease?: string | null;
}) {
  const ordered = [...detail.releases].sort((a, b) => b.releaseNumber - a.releaseNumber);
  const inFlight = ordered.find((r) => r.state !== 'superseded' && r.state !== 'deprecated' && r.state !== 'revoked') ?? ordered[0] ?? null;
  return (
    <div>
      <ReleaseStepper
        delegation={delegation}
        detail={detail}
        release={inFlight}
        draftState={detail.draft?.state ?? null}
        sa={sa}
        agentName={agentName}
        scopes={scopes}
        signHashFor={signHashFor}
        onReload={onReload}
        autoExpand={!!focusRelease}
      />
      <h2 className="subhead" style={{ marginTop: '1rem' }}>
        Every {VERSION_LABELS.cardRelease.toLowerCase()}
      </h2>
      {ordered.length === 0 ? (
        <p className="manage-card-blurb">No releases yet — the draft has never been frozen.</p>
      ) : (
        <div className="manage-grid">
          {ordered.map((r) => (
            <ReleaseRow key={r.releaseId} r={r} highlight={focusRelease === r.releaseId} />
          ))}
        </div>
      )}
    </div>
  );
}
