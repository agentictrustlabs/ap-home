'use client';
// THE ESTATE — the master gap analysis P1.4: one screen for everything this person stewards. Per agent: what it is, the
// playbook it runs (archetype · version · digest), where it runs and what it holds (the fleet lines), the grants in force,
// what it did this week (asks · vault calls, from its own counters), and its BUDGET — the one thing set here. Every
// number is read from the place that owns it; absent is said absent. A budget bounds how much, never what: a mandate
// still decides each act.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { useManagedAgents } from './ManagedAgents';
import { FleetLines } from './FleetLines';
import { PageHead, Section, List, Row, Empty, ErrorNote, Note, Button, Chip, Mono, Meta, SkeletonRows } from '../../ui';
import { auditGrantsThroughHarness } from '../../home/grants-harness';
import { agentBudget, type AgentBudgetView, type BudgetDay } from '../../home/ask';

interface Facts { playbook?: { archetypeId: string; archetypeVersion: string; digest: string } | null; grants?: number | null; budget?: AgentBudgetView | null; days?: BudgetDay[]; error?: string }

async function readPlaybook(token: string, agent: Address): Promise<Facts['playbook']> {
  const r = await fetch('/connect/channels', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'archetypeAssignmentGet', communityId: agent.toLowerCase() }) });
  const b = (await r.json().catch(() => ({}))) as { ok?: boolean; record?: { archetypeId?: string; archetypeVersion?: string; definitionDigest?: string } | null };
  if (!r.ok || !b.ok) return null;
  return b.record?.archetypeId ? { archetypeId: b.record.archetypeId, archetypeVersion: b.record.archetypeVersion ?? '?', digest: b.record.definitionDigest ?? '' } : null;
}

function BudgetEditor({ agent, budget, onSaved }: { agent: Address; budget: AgentBudgetView | null; onSaved: () => void }) {
  const { session } = useSession();
  const [asks, setAsks] = useState(budget?.asksPerDay?.toString() ?? '');
  const [calls, setCalls] = useState(budget?.vaultCallsPerDay?.toString() ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    if (!session) return;
    setBusy(true); setErr('');
    const r = await agentBudget({ token: session.token }, agent, { asksPerDay: asks.trim() ? Number(asks) : null, vaultCallsPerDay: calls.trim() ? Number(calls) : null });
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    onSaved();
  };
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
      <Meta>budget / day</Meta>
      <input className="ui-input" style={{ width: 90 }} placeholder="asks" inputMode="numeric" value={asks} onChange={(e) => setAsks(e.target.value.replace(/[^0-9]/g, ''))} aria-label="asks per day" />
      <input className="ui-input" style={{ width: 110 }} placeholder="vault calls" inputMode="numeric" value={calls} onChange={(e) => setCalls(e.target.value.replace(/[^0-9]/g, ''))} aria-label="vault calls per day" />
      <Button size="sm" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Set'}</Button>
      {err && <Meta>{err}</Meta>}
    </div>
  );
}

export function EstateView() {
  const { session, agentAddress, agentName } = useSession();
  const { agents, loaded } = useManagedAgents(session?.token ?? null, 'any');
  const [facts, setFacts] = useState<Record<string, Facts>>({});
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const mine = agentAddress ? [{ agent: agentAddress as Address, name: agentName ?? 'your agent', kind: 'person' as const, relationship: 'steward' as const }] : [];
  const stewarded = agents.filter((a) => (a.relationship ?? 'steward') === 'steward');
  const rows = [...mine, ...stewarded.map((a) => ({ agent: a.agent, name: a.name, kind: a.kind, relationship: 'steward' as const }))];

  const load = useCallback(async (agent: Address) => {
    if (!session || !agentAddress) return;
    const token = session.token;
    const [playbook, grants, budget] = await Promise.all([
      readPlaybook(token, agent).catch(() => null),
      auditGrantsThroughHarness({ person: agentAddress as Address, session: { token }, subject: agent }).then((r) => (r.ok ? r.audit.grants.filter((g) => !g.revoked).length : null)).catch(() => null),
      agentBudget({ token }, agent).catch(() => ({ ok: false as const, error: 'unreadable' })),
    ]);
    setFacts((f) => ({ ...f, [agent.toLowerCase()]: { playbook, grants, ...(budget.ok ? { budget: budget.budget, days: budget.days } : { budget: null, days: [], error: budget.error }) } }));
  }, [session, agentAddress]);
  useEffect(() => { if (!loaded) return; setError(null); for (const r of rows) void load(r.agent); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [loaded, agents.length, agentAddress, load]);

  const week = (days?: BudgetDay[]) => (days ?? []).reduce((acc, d) => ({ asks: acc.asks + d.asks, vaultCalls: acc.vaultCalls + d.vaultCalls }), { asks: 0, vaultCalls: 0 });
  return (
    <>
      <PageHead title="Estate" description="Everything you steward, on one screen: what each agent runs, where, what it may spend, what it did this week — and the budget you set on it. A budget bounds how much; a mandate still decides each act." actions={<a href="/estate/ops" className="ui-btn ui-btn--secondary">Operations →</a>} />
      {error && <ErrorNote>{error}</ErrorNote>}
      <Section title="Agents" count={rows.length} testId="estate-agents">
        {!loaded ? <SkeletonRows rows={3} lead /> : rows.length === 0 ? <Empty title="Nothing to steward yet">Charter an organization or a service and it appears here.</Empty> : (
          <List>
            {rows.map((r) => {
              const f = facts[r.agent.toLowerCase()];
              const w = week(f?.days);
              const todayC = f?.days?.[0];
              const over = f?.budget && ((f.budget.asksPerDay !== null && (todayC?.asks ?? 0) >= f.budget.asksPerDay) || (f.budget.vaultCallsPerDay !== null && (todayC?.vaultCalls ?? 0) >= f.budget.vaultCallsPerDay));
              return (
                <Row key={r.agent} testId="estate-row"
                  title={<span><strong>{r.name}</strong> <Chip>{r.kind}</Chip> {over && <Chip tone="danger">budget spent today</Chip>}</span>}
                  meta={<span style={{ display: 'grid', gap: 2 }}>
                    <span><Meta>playbook</Meta> {f === undefined ? '…' : f.playbook ? <>{f.playbook.archetypeId} v{f.playbook.archetypeVersion} <Mono title={f.playbook.digest}>{f.playbook.digest.slice(0, 12)}…</Mono></> : 'none assigned (the bare harness)'}</span>
                    <span><Meta>grants in force</Meta> {f === undefined ? '…' : f.grants === null ? 'not readable from here' : f.grants}</span>
                    <span><Meta>this week</Meta> {f === undefined ? '…' : f.error ? f.error : `${w.asks} ask${w.asks === 1 ? '' : 's'} · ${w.vaultCalls} vault calls${todayC ? ` (today ${todayC.asks} · ${todayC.vaultCalls})` : ''}`}</span>
                    <span><Meta>budget</Meta> {f === undefined ? '…' : f.budget && (f.budget.asksPerDay !== null || f.budget.vaultCallsPerDay !== null) ? `${f.budget.asksPerDay ?? '∞'} asks · ${f.budget.vaultCallsPerDay ?? '∞'} vault calls per day${f.budget.setAt ? ` (set ${new Date(f.budget.setAt).toLocaleDateString()})` : ''}` : 'unbounded'} <button type="button" className="ghost" style={{ display: 'inline', padding: 0, minHeight: 0, fontSize: 'inherit' }} onClick={() => setEditing(editing === r.agent ? null : r.agent)}>{editing === r.agent ? 'close' : 'set'}</button></span>
                    {editing === r.agent && <BudgetEditor agent={r.agent} budget={f?.budget ?? null} onSaved={() => { setEditing(null); void load(r.agent); }} />}
                    {session && <FleetLines agent={r.agent} token={session.token} stewardship={r.kind !== 'person'} />}
                  </span>}
                  side={<Mono>{r.agent.slice(0, 10)}…</Mono>} />
              );
            })}
          </List>
        )}
      </Section>
      <Note>Counters are the runtime&rsquo;s own, by UTC day, rebuilt from the run records if ever lost. An ask over budget is refused at the door with the reason — nothing degrades silently. Money is not bounded here: a treasury&rsquo;s mandate caveats do that.</Note>
    </>
  );
}
