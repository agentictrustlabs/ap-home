'use client';
// THE ACCOUNTABLE WORK ITEM, RENDERED — spec 398 §4.3: the eight facts in one place, on every surface that shows the
// item. An absent fact is said absent ("acceptance: nobody named yet"); nothing is filled in.
import { StatePill } from '../StatePill';
import { AgentName } from '../../shared/AgentName';
import type { WorkItemV1 } from '../../../home/work-item';

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', fontSize: '0.78rem', lineHeight: 1.5 }}>
      <span style={{ flex: 'none', width: 92, opacity: 0.6 }}>{k}</span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}

export function WorkItemCard({ item, org }: { item: WorkItemV1; org: string }) {
  const a = item.acceptance;
  return (
    <div data-testid="work-item" style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', marginTop: '0.5rem' }}>
      <Row k="goal">{item.goal}</Row>
      <Row k="accountable"><AgentName address={item.owner.agent as `0x${string}`} /> (organization)</Row>
      <Row k="executors">{item.executors.length === 0 ? <span style={{ opacity: 0.6 }}>nobody allocated yet</span> : item.executors.map((x, i) => <span key={x.agent}>{i > 0 ? ', ' : ''}{x.name ?? <AgentName address={x.agent as `0x${string}`} />} ({x.via}, {x.steps} step{x.steps === 1 ? '' : 's'})</span>)}</Row>
      <Row k="status"><StatePill state={item.state} native={item.native} compact /></Row>
      <Row k="conversation">{item.conversation ? <a href={`/org/${org}/discussions?topic=${encodeURIComponent(item.conversation.topicId)}`}>open the topic →</a> : <span style={{ opacity: 0.6 }}>no topic linked</span>}</Row>
      <Row k="artifacts">{item.artifacts.length === 0 ? <span style={{ opacity: 0.6 }}>none linked to this item yet — a run's artifacts are on its record (Activities)</span> : item.artifacts.map((x) => <span key={x.ref}>{x.kind} {x.ref} </span>)}</Row>
      <Row k="acceptance">
        {a.criteria.length === 0 && a.approvers.length === 0 ? <span style={{ opacity: 0.6 }}>no criteria, nobody named — a steward can revise the outcome</span> : (
          <>
            {a.criteria.length > 0 && <span>{a.criteria.join(' · ')}</span>}
            {a.approvers.length > 0 && <span>{a.criteria.length > 0 ? ' — ' : ''}decided by {a.approvers.map((p, i) => <span key={`${p.agent}:${i}`}>{i > 0 ? ', ' : ''}<AgentName address={p.agent as `0x${string}`} />{p.decisionKind ? ` (${p.decisionKind}${p.pending ? ', pending' : ''})` : p.pending ? ' (pending)' : ''}</span>)}</span>}
          </>
        )}
      </Row>
      <Row k="cost">{item.cost ? `${item.cost.vaultCalls} vault calls · ${item.cost.doRequests} serving requests` : <span style={{ opacity: 0.6 }}>not carried on the item yet — each run's bill is on its record</span>}</Row>
    </div>
  );
}
