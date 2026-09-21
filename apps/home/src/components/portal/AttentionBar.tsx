'use client';
// ATTENTION, NOT NOTIFICATIONS — spec 398 §5.5, in the shape of an inbox (2026-09-20). What needs the person sits at
// the TOP OF THE RAIL, pinned above the conversations, in three folded groups: NEEDS YOU (decisions and questions —
// open by default), WAITING (on someone else, or a failed routine), FINISHED (artifacts). A group with nothing in it
// is not drawn; a count of zero is never shown; "unread" is a filter on the conversations, not a group beside them.
// Each card is ONE object with ONE action set — an inbox case keeps its approve/decline actions (rendered by the
// caller), a parked run its cancel, everything else opens where it is acted on. Six filters remain the MODEL
// (`attention.ts`); this is only how the screen folds them.
import { useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { assembleAttention, attentionGroups, type AttentionGroupId, type AttentionInputs, type AttentionItem } from '../../home/attention';
import { StatePill } from './StatePill';
import { RunControls } from './runs/RunControls';
import { Button } from '../../ui';

export function AttentionGroups({ inputs, token, addressee, only, onCanceled, renderCaseActions, onOpenDm, onOpenCase }: {
  inputs: AttentionInputs; token: string; addressee: Address;
  /** Show these groups only (the "Needs you" filter shows every group, all unfolded); absent ⇒ the pinned strip. */
  only?: 'all-open';
  onCanceled: (runRef: string) => void;
  renderCaseActions: (caseId: string) => React.ReactNode; onOpenDm: (key: string) => void; onOpenCase: (caseId: string) => void;
}) {
  const groups = useMemo(() => attentionGroups(assembleAttention(inputs)), [inputs]);
  const [folded, setFolded] = useState<Partial<Record<AttentionGroupId, boolean>>>({});
  if (groups.length === 0) return null;
  return (
    <div className="chat-attention-groups" data-testid="attention-bar">
      {groups.map((g) => {
        const open = only === 'all-open' ? true : (folded[g.id] === undefined ? g.open : !folded[g.id]);
        return (
          <section key={g.id} className={`chat-attention-group chat-attention-group--${g.id}`} data-testid={`attention-${g.id}`} data-count={g.items.length}>
            <button type="button" className="chat-attention-group__head" aria-expanded={open} title={g.hint} onClick={() => setFolded((f) => ({ ...f, [g.id]: open }))} /* folded = it was open */>
              <span className="chat-attention-group__chev" aria-hidden>{open ? '▾' : '▸'}</span>
              <span className="chat-attention-group__label">{g.label}</span>
              <span className={`chat-attention-group__count${g.id === 'needs-you' ? ' chat-attention-group__count--act' : ''}`}>{g.items.length}</span>
            </button>
            {open && g.items.map((it) => <AttentionRow key={it.id} item={it} token={token} addressee={addressee} onCanceled={onCanceled} renderCaseActions={renderCaseActions} onOpenDm={onOpenDm} onOpenCase={onOpenCase} />)}
          </section>
        );
      })}
    </div>
  );
}

function AttentionRow({ item, token, addressee, onCanceled, renderCaseActions, onOpenDm, onOpenCase }: {
  item: AttentionItem; token: string; addressee: Address; onCanceled: (runRef: string) => void;
  renderCaseActions: (caseId: string) => React.ReactNode; onOpenDm: (key: string) => void; onOpenCase: (caseId: string) => void;
}) {
  const href = item.href ?? (item.askSeed ? `/ask?seed=${encodeURIComponent(item.askSeed)}` : undefined);
  const open = item.caseId ? () => onOpenCase(item.caseId!) : item.dmKey ? () => onOpenDm(item.dmKey!) : undefined;
  return (
    <div className="chat-attention-card" data-testid="attention-card">
      <div className="chat-attention-card__body">
        {href ? <a className="chat-attention-card__title" href={href}>{item.title}</a> : open ? <button type="button" className="chat-attention-card__title chat-attention-card__title--btn" onClick={open}>{item.title}</button> : <span className="chat-attention-card__title">{item.title}</span>}
        {item.detail && <div className="chat-attention-card__detail">{item.detail}</div>}
      </div>
      <div className="chat-attention-card__side">
        {item.state && <StatePill state={item.state} {...(item.native ? { native: item.native } : {})} compact />}
        {item.caseId && renderCaseActions(item.caseId)}
        {item.caseId && <Button size="sm" variant="ghost" onClick={() => onOpenCase(item.caseId!)}>Thread</Button>}
        {item.dmKey && <Button size="sm" variant="ghost" onClick={() => onOpenDm(item.dmKey!)}>Open</Button>}
        {item.runRef && <RunControls token={token} addressee={addressee} runRef={item.runRef} compact onCanceled={() => onCanceled(item.runRef!)} />}
      </div>
    </div>
  );
}
