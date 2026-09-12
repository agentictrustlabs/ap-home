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
import { List, Row, Button } from '../../ui';

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
    <div className="ui-section" data-testid="attention-bar" style={{ marginBottom: 'var(--sp-4)' }}>
      <div className="ui-toolbar" style={{ marginBottom: 'var(--sp-2)' }}>
        <div className="ui-tabs" role="tablist" aria-label="What needs your attention">
          {counts.map((c) => (
            <button
              key={c.id} type="button" role="tab" data-testid={`attention-${c.id}`} data-count={c.count}
              className="ui-tab" aria-selected={open === c.id}
              onClick={() => setPicked(c.id)} disabled={c.count === 0} title={ATTENTION_FILTERS.find((f) => f.id === c.id)?.hint}
            >
              {c.label}<span className="ui-count">{c.count}</span>
            </button>
          ))}
        </div>
        {hint && <span className="ui-meta">{hint}</span>}
      </div>
      <List>
        {items.map((it) => <AttentionRow key={it.id} item={it} token={token} addressee={addressee} onCanceled={onCanceled} renderCaseActions={renderCaseActions} onOpenDm={onOpenDm} onOpenCase={onOpenCase} />)}
      </List>
    </div>
  );
}

function AttentionRow({ item, token, addressee, onCanceled, renderCaseActions, onOpenDm, onOpenCase }: {
  item: AttentionItem; token: string; addressee: Address; onCanceled: (runRef: string) => void;
  renderCaseActions: (caseId: string) => React.ReactNode; onOpenDm: (key: string) => void; onOpenCase: (caseId: string) => void;
}) {
  const href = item.href ?? (item.askSeed ? `/ask?seed=${encodeURIComponent(item.askSeed)}` : undefined);
  const side = (
    <>
      {item.state && <StatePill state={item.state} {...(item.native ? { native: item.native } : {})} compact />}
      {item.caseId && renderCaseActions(item.caseId)}
      {item.caseId && <Button size="sm" variant="ghost" onClick={() => onOpenCase(item.caseId!)}>Open thread</Button>}
      {item.dmKey && <Button size="sm" variant="ghost" onClick={() => onOpenDm(item.dmKey!)}>Open</Button>}
      {item.runRef && <RunControls token={token} addressee={addressee} runRef={item.runRef} compact onCanceled={() => onCanceled(item.runRef!)} />}
    </>
  );
  return <Row title={item.title} meta={item.detail} side={side} {...(href ? { titleHref: href } : {})} testId="attention-card" />;
}
