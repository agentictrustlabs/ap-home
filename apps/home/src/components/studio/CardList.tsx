'use client';
// The cards list. An agent normally has ONE card, so this screen is not where a steward should land — with a
// single card the section opens it directly (see CardStudio). This renders only the cases where a list is real:
// no card yet, or more than one. A row therefore answers "which card is this and is it live", nothing else;
// every action belongs to the card's own tabs, not to a row in a list.
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createCard, newMutation, type CardListEntry, type DelegationWire, type StoredProjection } from '../../studio-client';
import { cardRowView } from '../../lib/studio-flow';
import { studioErrorSentence } from '../../lib/studio-view';
import { BusyButton } from '../shared/BusyButton';
import { ErrorLine } from './ui';
import { TONE_COLOR } from './parts';
import { notifyCardChanged } from './useStudio';

export function CardList({
  delegation, cards, projections, loaded, error, basePath, onReload,
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
  const [localError, setLocalError] = useState<string | null>(null);

  const create = useCallback(async () => {
    setCreating(true);
    setLocalError(null);
    try {
      const res = await createCard(delegation, {}, newMutation());
      notifyCardChanged();
      router.push(`${basePath}/${encodeURIComponent(res.resource.cardResourceId)}`);
    } catch (e) {
      setLocalError(studioErrorSentence(e instanceof Error ? e.message : String(e)));
    } finally {
      setCreating(false);
    }
  }, [delegation, basePath, router]);

  if (!loaded) return <p className="manage-card-blurb">Loading…</p>;

  const listedTotal = 2; // the places this Home can list an agent (name record, directory)
  const listedCount = projections.filter((p) => p.instance.lastPublication).length;

  return (
    <div>
      <ErrorLine error={error ?? localError} />
      {cards.length === 0 ? (
        <div className="manage-card">
          <h2 className="subhead" style={{ marginTop: 0 }}>This agent doesn&rsquo;t have a card yet</h2>
          <p className="manage-card-blurb">
            A card is what other agents see when they look this one up — what it does and how to reach it. We can
            fill one in from this agent&rsquo;s profile, names and running service; you review it before anything
            goes public.
          </p>
          <BusyButton busy={creating} busyLabel="Filling it in…" className="btn-primary" onClick={() => void create()}>
            Create from profile
          </BusyButton>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gap: '.5rem' }}>
            {cards.map((entry) => {
              const href = `${basePath}/${encodeURIComponent(entry.resource.cardResourceId)}`;
              const row = cardRowView({
                displayName: entry.resource.displayName,
                environment: entry.resource.environment,
                primary: entry.resource.primary,
                draftState: entry.draftState,
                releaseState: entry.latestRelease?.state ?? null,
                servedReleaseId: entry.servedReleaseId,
                listedCount,
                listedTotal,
              });
              return (
                <a
                  key={entry.resource.cardResourceId}
                  href={href}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: '.8rem', flexWrap: 'wrap', alignItems: 'baseline', textDecoration: 'none', color: 'inherit', border: '1px solid var(--c-g200)', borderRadius: 8, padding: '.7rem' }}
                >
                  <span>
                    <span style={{ display: 'block', fontWeight: 700, fontSize: '.86rem' }}>{row.title}</span>
                    <span className="manage-card-blurb" style={{ margin: 0 }}>{row.subtitle}</span>
                  </span>
                  <span style={{ fontSize: '.78rem', fontWeight: 700, color: TONE_COLOR[row.tone] }}>{row.status}</span>
                </a>
              );
            })}
          </div>
          <BusyButton busy={creating} busyLabel="Filling it in…" className="btn-ghost" style={{ marginTop: '.6rem' }} onClick={() => void create()}>
            Add another card
          </BusyButton>
          <p className="manage-card-blurb" style={{ margin: '.3rem 0 0', fontSize: '.72rem' }}>
            A second card is for a genuinely different deployment or audience — most agents need only one.
          </p>
          <button type="button" className="btn-ghost" style={{ marginTop: '.4rem' }} onClick={onReload}>Refresh</button>
        </>
      )}
    </div>
  );
}
