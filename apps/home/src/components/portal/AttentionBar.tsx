'use client';
// ATTENTION, NOT NOTIFICATIONS — spec 398 §5.5. Six chips above the Messages rail: needs my decision · needs my input ·
// blocked · failed routine · finished artifact · unread. Each shows a count; one is open at a time; a card is ONE
// object with ONE action set — an inbox case keeps its approve/decline actions (rendered by the caller), a parked
// run its cancel, everything else opens where it is acted on. Unread is a filter here, not a badge on a decision.
import { useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { assembleAttention, attentionCounts, ATTENTION_FILTERS, type AttentionFilter, type AttentionInputs, type AttentionItem } from '../../home/attention';
import { StatePill } from './StatePill';
import { RunControls } from './runs/RunControls';

export function AttentionBar({ inputs, token, addressee, onCanceled, renderCaseActions, onOpenDm, onOpenCase }: {
  inputs: AttentionInputs; token: string; addressee: Address; onCanceled: (runRef: string) => void;
  renderCaseActions: (caseId: string) => React.ReactNode; onOpenDm: (key: string) => void; onOpenCase: (caseId: string) => void;
}) {
  const attention = useMemo(() => assembleAttention(inputs), [inputs]);
  const counts = attentionCounts(attention);
  const first = counts.find((c) => c.count > 0)?.id ?? null;
  const [picked, setPicked] = useState<AttentionFilter | null>(null);
  const open = picked && attention[picked].length > 0 ? picked : first;
  const total = counts.reduce((n, c) => n + c.count, 0);
  if (total === 0) return null;
  const items = open ? attention[open] : [];
  const hint = ATTENTION_FILTERS.find((f) => f.id === open)?.hint;
  return (
    <div className="chat-attention" data-testid="attention-bar">
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.5rem' }}>
        {counts.map((c) => (
          <button
            key={c.id} type="button" data-testid={`attention-${c.id}`} data-count={c.count}
            className={`chat-rail-action${open === c.id ? ' chat-rail-action--active' : ''}`}
            style={{ opacity: c.count === 0 ? 0.5 : 1, fontWeight: open === c.id ? 700 : 500 }}
            onClick={() => setPicked(c.id)} disabled={c.count === 0} title={ATTENTION_FILTERS.find((f) => f.id === c.id)?.hint}
          >
            {c.label} · {c.count}
          </button>
        ))}
      </div>
      {hint && <div style={{ fontSize: '0.74rem', opacity: 0.65, marginBottom: '0.4rem' }}>{hint}</div>}
      {items.map((it) => <AttentionCard key={it.id} item={it} token={token} addressee={addressee} onCanceled={onCanceled} renderCaseActions={renderCaseActions} onOpenDm={onOpenDm} onOpenCase={onOpenCase} />)}
    </div>
  );
}

function AttentionCard({ item, token, addressee, onCanceled, renderCaseActions, onOpenDm, onOpenCase }: {
  item: AttentionItem; token: string; addressee: Address; onCanceled: (runRef: string) => void;
  renderCaseActions: (caseId: string) => React.ReactNode; onOpenDm: (key: string) => void; onOpenCase: (caseId: string) => void;
}) {
  const href = item.href ?? (item.askSeed ? `/ask?seed=${encodeURIComponent(item.askSeed)}` : undefined);
  return (
    <div data-testid="attention-card" style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', padding: '0.6rem 0.8rem', background: '#fff', border: '1px solid var(--color-border)', borderRadius: 8, marginBottom: '0.4rem' }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <b>{href ? <a href={href} style={{ color: 'inherit', textDecoration: 'none' }}>{item.title}</a> : item.title}</b>
        {item.detail && <div style={{ fontSize: '0.82rem', opacity: 0.75 }}>{item.detail}</div>}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        {item.state && <StatePill state={item.state} {...(item.native ? { native: item.native } : {})} compact />}
        {item.caseId && renderCaseActions(item.caseId)}
        {item.caseId && <button type="button" className="ghost" onClick={() => onOpenCase(item.caseId!)}>Open thread</button>}
        {item.dmKey && <button type="button" className="ghost" onClick={() => onOpenDm(item.dmKey!)}>Open</button>}
        {item.runRef && <RunControls token={token} addressee={addressee} runRef={item.runRef} compact onCanceled={() => onCanceled(item.runRef!)} />}
      </div>
    </div>
  );
}
