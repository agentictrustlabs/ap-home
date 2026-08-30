'use client';
// The cards list (design §2). A management roster — card rows, never a spreadsheet — plus the one empty
// state that matters: "Create from profile", which explains INHERITANCE before the button.
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { summarizeProjections, VERSION_LABELS } from '@agenticprimitives/home';
import { BusyButton } from '../shared/BusyButton';
import { cardRowFrom, gateForOp, projectionRowFrom } from '../../lib/studio-view';
import { createCard, newMutation, validateCard, type CardListEntry, type DelegationWire, type StoredProjection } from '../../studio-client';
import { Chip, Digest, ErrorLine } from './ui';
import { notifyCardChanged } from './useStudio';

const ENV_TONE = { production: 'good', staging: 'warn', development: 'warn' } as const;
const ENV_LABEL = { production: 'Production', staging: 'Staging', development: 'Development' } as const;

const ACTION_LABEL: Record<string, string> = {
  edit: 'Open',
  validate: 'Validate',
  'create-release': 'Create release',
  'request-approval': 'Request approval',
  sign: 'Sign',
  publish: 'Publish',
  deprecate: 'Deprecate',
  revoke: 'Revoke',
};

export function CardList({
  delegation,
  cards,
  projections,
  scopes,
  loaded,
  error,
  basePath,
  onReload,
}: {
  delegation: DelegationWire;
  cards: CardListEntry[];
  projections: StoredProjection[];
  scopes: readonly string[];
  loaded: boolean;
  error: string | null;
  /** `/org/<sa>/card` or `/service/<sa>/card`. */
  basePath: string;
  onReload(): void;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const create = useCallback(
    async (thenImport: boolean) => {
      setCreating(true);
      setLocalError(null);
      try {
        const res = await createCard(delegation, {}, newMutation());
        notifyCardChanged();
        router.push(`${basePath}/${encodeURIComponent(res.resource.cardResourceId)}${thenImport ? '?import=1' : ''}`);
      } catch (e) {
        setLocalError(e instanceof Error ? e.message : String(e));
      } finally {
        setCreating(false);
      }
    },
    [delegation, basePath, router],
  );

  if (!loaded) {
    return (
      <div className="manage-grid">
        {[0, 1, 2].map((i) => (
          <div key={i} className="manage-card soon" aria-hidden>
            <p className="manage-card-blurb">Loading…</p>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="manage-card">
        <p className="manage-card-blurb">Couldn&rsquo;t load this agent&rsquo;s cards. Try again.</p>
        <button type="button" className="btn-ghost" style={{ marginTop: '.5rem' }} onClick={onReload}>
          Try again
        </button>
        <ErrorLine error={error} />
      </div>
    );
  }

  if (cards.length === 0) {
    const gate = gateForOp(scopes, 'card.create');
    return (
      <div className="manage-card" style={{ maxWidth: 560 }}>
        <div className="manage-card-head">
          <span aria-hidden style={{ fontSize: '1.2rem' }}>
            🪪
          </span>
          <span className="manage-card-label">This agent doesn&rsquo;t have an A2A card yet</span>
        </div>
        <p className="manage-card-blurb" style={{ margin: '.4rem 0 .8rem' }}>
          A card is what other A2A agents see when they look this agent up — its name, what it can do, and how to
          reach it. It starts from what&rsquo;s already true about the agent: its profile, its public capabilities,
          and how it&rsquo;s deployed. You&rsquo;ll review and curate before anything is signed or published —
          nothing here is public until you release it.
        </p>
        <BusyButton busy={creating} busyLabel="Creating…" className="btn-primary" disabled={!gate.allowed} title={gate.reason} onClick={() => void create(false)}>
          Create from profile
        </BusyButton>
        <div style={{ marginTop: '.5rem' }}>
          <button
            type="button"
            className="btn-ghost"
            style={{ border: 'none', padding: 0, fontWeight: 500, color: 'var(--c-g500)' }}
            disabled={creating || !gate.allowed}
            onClick={() => void create(true)}
          >
            Import an existing A2A card instead
          </button>
        </div>
        <ErrorLine error={localError} />
      </div>
    );
  }

  return (
    <div>
      <ErrorLine error={localError} />
      <div className="manage-grid">
        {cards.map((entry) => {
          const row = cardRowFrom(entry, {
            scopes,
            projections: summarizeProjections(
              projections.map((p) => projectionRowFrom(p, { scopes, latestReleaseDigest: entry.latestRelease?.signedContentDigest ?? entry.latestRelease?.unsignedContentDigest ?? null })),
            ),
          });
          const href = `${basePath}/${encodeURIComponent(row.cardResourceId)}`;
          return (
            <div key={row.cardResourceId} className="manage-card">
              <div className="manage-card-head">
                <span className="manage-card-label">{row.displayName}</span>
                {row.primary && <Chip tone="accent">Primary</Chip>}
                <Chip tone={ENV_TONE[row.environment]}>{ENV_LABEL[row.environment]}</Chip>
              </div>

              <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', margin: '.35rem 0' }}>
                {row.draftState === 'dirty' && <span className="manage-card-blurb">Unsaved changes</span>}
                {row.draftState === 'stale' && <Chip tone="warn">⚠ Source changed</Chip>}
                {row.draftState === 'conflict' && <Chip tone="danger">✕ Conflict</Chip>}
              </div>

              {row.latestRelease ? (
                <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', alignItems: 'center', margin: '.2rem 0' }}>
                  <span style={{ fontSize: '.78rem', fontWeight: 600 }}>
                    {VERSION_LABELS.cardRelease} {row.latestRelease.releaseNumber}
                  </span>
                  <Chip tone={row.latestRelease.state === 'published' ? 'good' : row.latestRelease.state === 'revoked' ? 'danger' : 'muted'}>{row.latestRelease.state}</Chip>
                  {row.latestRelease.signed && (
                    <span title="Card signature attached (any A2A client can check it)" aria-label="Card signature attached">
                      🔒
                    </span>
                  )}
                  {row.latestRelease.smartAgentBound && (
                    <span title="Smart Agent binding attached" aria-label="Smart Agent binding attached">
                      🔗
                    </span>
                  )}
                  <Digest value={row.latestRelease.contentDigest} />
                </div>
              ) : (
                <p className="manage-card-blurb" style={{ margin: '.2rem 0' }}>
                  No {VERSION_LABELS.cardRelease.toLowerCase()} yet.
                </p>
              )}

              <p className="manage-card-blurb" style={{ margin: '.2rem 0' }}>
                {entry.servedReleaseId ? 'Serving a released card at the well-known endpoint.' : 'Not published'}
                {' · '}
                {row.projections.total} target{row.projections.total === 1 ? '' : 's'}
                {row.projections.drifted > 0 && <span style={{ color: 'var(--c-danger)' }}> · {row.projections.drifted} drifted</span>}
                {row.projections.stale > 0 && <span style={{ color: 'var(--color-amber-700)' }}> · {row.projections.stale} stale</span>}
              </p>

              <div style={{ display: 'flex', gap: '.35rem', flexWrap: 'wrap', marginTop: '.5rem' }}>
                {row.actions.map((a) =>
                  a === 'validate' ? (
                    <BusyButton
                      key={a}
                      busy={validatingId === row.cardResourceId}
                      busyLabel="Validating…"
                      className="btn-ghost"
                      onClick={() => {
                        setValidatingId(row.cardResourceId);
                        void validateCard(delegation, row.cardResourceId)
                          .catch((e: unknown) => setLocalError(e instanceof Error ? e.message : String(e)))
                          .finally(() => {
                            setValidatingId(null);
                            onReload();
                          });
                      }}
                    >
                      Validate
                    </BusyButton>
                  ) : (
                    <a key={a} className="btn-ghost" href={a === 'edit' ? href : `${href}/releases`}>
                      {ACTION_LABEL[a] ?? a}
                    </a>
                  ),
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: '.8rem' }}>
        <BusyButton
          busy={creating}
          busyLabel="Creating…"
          className="btn-ghost"
          disabled={!gateForOp(scopes, 'card.create').allowed}
          title={gateForOp(scopes, 'card.create').reason}
          onClick={() => void create(false)}
        >
          Create another card from profile
        </BusyButton>
      </div>
    </div>
  );
}
