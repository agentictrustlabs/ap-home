'use client';
// Activities — the Home's control-plane timeline (spec 310 W4/W5): every
// grant/revoke, agent lifecycle, inbox decision, and Home rotation, each row
// backed by an audit entry (`auditRef`). Plus the portable managed-agents
// projection (ManagedAgentEntryV1) over the spec 275 tree. Projections render
// authority — the on-chain / vault records stay canonical.
import { useEffect, useState } from 'react';
import type { HomeControlEventV1, ManagedAgentEntryV1 } from '@agenticprimitives/home';
import { useSession } from '../../context/session';
import { SectionShell } from '../../components/portal/SectionShell';
import { List, Row, Panel, Mono, DayHeader, timeLabel, type PanelState } from '../../ui';
import { InboxIcon } from './today-icons';
import { useManagedAgents } from '../../components/portal/ManagedAgents';
import { listControlEvents, toManagedAgentEntry } from '../../home/control-plane';
import { AddressChip } from '../../components/shared/AddressChip';
import { RunHistory } from './runs/RunHistory';

const EVENT_COPY: Record<HomeControlEventV1['eventType'], string> = {
  'grant-issued': 'Delegation granted',
  'grant-revoked': 'Delegation revoked',
  'agent-added': 'Agent added to your tree',
  'agent-disabled': 'Agent disabled',
  'credential-issued': 'Credential issued',
  'credential-received': 'Credential received',
  'inbox-decision': 'Inbox decision recorded',
  'home-rotated': 'Home manifest published',
  // spec 347 — Agent Card & Projection Studio
  'card-released': 'Agent card released',
  'card-published': 'Agent card published',
  'projection-published': 'Registry projection published',
  'binding-revoked': 'External binding revoked',
  // spec 422 §7 — the Security section
  'credential-added': 'A credential that signs for you was added',
  'credential-retired': 'A credential was retired',
  'channel-linked': 'An email or phone now opens your home',
  'channel-unlinked': 'An email or phone was unlinked',
};

/** spec 348 §2.1 — `agent` scopes the timeline to events ABOUT one managed agent, for an org's or a
 *  service's Activities. The events are the person's Home control plane either way (there is one control
 *  plane, not one per agent); scoping filters it to the rows that name this agent, so a workspace's
 *  Activities is a true subset of yours rather than a separate, thinner feed. */
export function ActivityTimeline({ agent }: { agent?: string } = {}) {
  const { session, agentAddress } = useSession();
  const [events, setEvents] = useState<HomeControlEventV1[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { agents } = useManagedAgents(session?.token ?? null);

  useEffect(() => {
    if (!session) { setLoaded(true); return; }
    let cancelled = false;
    void listControlEvents(session.token).then((e) => {
      if (!cancelled) { setEvents(e); setLoaded(true); }
    });
    return () => { cancelled = true; };
  }, [session]);

  const entries: ManagedAgentEntryV1[] = agentAddress
    ? agents.map((a) => toManagedAgentEntry(a, agentAddress))
    : [];

  // An event is "about" an agent when it acted as it, or when any of its refs names it. Matching on the
  // raw address covers both the bare form and the CAIP-10 the actor carries.
  const needle = agent?.toLowerCase();
  const shown = needle
    ? events.filter((e) => JSON.stringify([e.actor, e.refs]).toLowerCase().includes(needle))
    : events;

  return (
    <SectionShell
      title="Activities"
      description={agent ? 'What changed for this agent, when, and the audit reference behind it.' : 'What changed, when, and the audit reference behind it — the on-chain and vault records stay canonical.'}
    >
      {/* Spec 381 W3 — the runs this person asked of this agent, from the agent's own records; opened, a timeline. */}
      {session && (agent ?? agentAddress) && <RunHistory token={session.token} addressee={(agent ?? agentAddress) as `0x${string}`} />}

      <Panel title="Control plane" icon={<InboxIcon />} count={shown.length} state={(!loaded ? 'loading' : shown.length ? 'ready' : 'empty') as PanelState} rows={3} testId="control-plane"
        aside={<span>grants, credentials, cards, your Home's manifest — with the audit reference behind each</span>}
        empty={{ icon: <InboxIcon />, title: 'Nothing recorded yet', hint: agent ? 'Releasing a card, publishing a projection, issuing a grant or changing its lifecycle all land here.' : 'Publishing your Home manifest, deciding an inbox request, revoking a delegation, or adding an agent all land here.' }}>
        <div style={{ padding: '0 var(--sp-4) var(--sp-3)' }}>
          {(() => { const groups: Array<{ day: string; rows: HomeControlEventV1[] }> = []; for (const e of shown) { const d = new Date(e.at).toDateString(); const last = groups[groups.length - 1]; if (last && last.day === d) last.rows.push(e); else groups.push({ day: d, rows: [e] }); } return groups; })().map((g) => (
            <div key={g.day}>
              <DayHeader at={g.rows[0]!.at} />
              <List>
                {g.rows.map((e) => (
                  <Row key={e.auditRef} title={EVENT_COPY[e.eventType]}
                    meta={<>audit <Mono>{e.auditRef.slice(0, 8)}</Mono>{e.refs.map((r, i) => <span key={i}> · <Mono>{typeof r === 'object' && 'hash' in r ? `${r.kind} ${r.hash.slice(0, 10)}…` : 'ref'}</Mono></span>)}</>}
                    side={<span className="ui-row-time" title={new Date(e.at).toLocaleString()}>{timeLabel(e.at)}</span>} />
                ))}
              </List>
            </div>
          ))}
        </div>
      </Panel>

      {entries.length > 0 && (
        <Panel title="Managed agents" count={entries.length} state="ready" aside={<span>the portable <Mono>ManagedAgentEntryV1</Mono> rows any Home would render for your tree</span>}>
          <List>
            {entries.map((m) => {
              const address = m.agent.match(/0x[0-9a-fA-F]{40}$/)?.[0] as `0x${string}` | undefined;
              return (
                <Row key={m.agent} title={address ? <AddressChip address={address} size="sm" /> : m.agent} meta={<>{m.agentType} · {m.relationship.replaceAll('_', ' ')} · control: <b>{m.controlGrade}</b> · {m.status}</>} />
              );
            })}
          </List>
        </Panel>
      )}
    </SectionShell>
  );
}
