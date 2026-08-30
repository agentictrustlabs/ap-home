'use client';
// Pieces every Studio flow shares (flow-redesign.md, split of 2026-08-30): the Agent Card flow, each listing
// flow and History are separate screens now, so the stage frame, the tone map, the URL flag and the typed-name
// derivation live here instead of being copied three ways.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { StageStatus } from '../../lib/studio-flow';
import type { CardDetail } from '../../studio-client';

export const TONE_COLOR: Record<StageStatus['tone'], string> = { good: 'var(--color-sage-700, #3f6b4a)', warn: 'var(--c-warn, #b45309)', muted: 'var(--c-g700)' };

export function Stage({ n, title, status, dimmed, id, children }: { n?: string; title: string; status: { tone: StageStatus['tone']; text: string }; dimmed?: boolean; id?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`stage-${n ?? title}`} className="manage-card" style={{ marginBottom: '.8rem', opacity: dimmed ? 0.62 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '.8rem', flexWrap: 'wrap' }}>
        <h2 id={`stage-${n ?? title}`} className="subhead" style={{ margin: 0 }}>
          {n && <span aria-hidden style={{ display: 'inline-block', width: 22, height: 22, lineHeight: '22px', textAlign: 'center', borderRadius: 999, background: 'var(--c-primary-subtle)', color: 'var(--c-primary)', fontSize: '.72rem', marginRight: '.45rem' }}>{n}</span>}
          {title}
        </h2>
        <span style={{ fontSize: '.78rem', fontWeight: 700, color: TONE_COLOR[status.tone] }}>{status.text}</span>
      </div>
      <div style={{ marginTop: '.5rem' }}>{children}</div>
    </section>
  );
}

/** A persistent (not one-shot) URL flag, so a sub-screen survives a refresh and the back button. */
export function useUrlFlag(name: string): [boolean, (on: boolean) => void] {
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

/**
 * The TYPED name (`accelerate.team`) — what hosts and name records are built from. `agentName` may be an org's
 * display label ("Accelerate"); when the card's name was inherited from naming, the card carries the typed one.
 */
export function typedNameOf(detail: CardDetail, agentName: string): string {
  const d = detail.draft;
  return d?.fieldBindings['/name']?.source.kind === 'agent-naming' && d.card.name ? d.card.name : agentName;
}

export function decodeKid(protectedHeader: string): string {
  const json = atob(protectedHeader.replace(/-/g, '+').replace(/_/g, '/'));
  const kid = (JSON.parse(json) as { kid?: string }).kid;
  if (!kid) throw new Error('the prepared card signature carries no kid');
  return kid;
}
