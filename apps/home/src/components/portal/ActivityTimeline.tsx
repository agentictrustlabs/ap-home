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
import { useManagedAgents } from '../../components/portal/ManagedAgents';
import { listControlEvents, toManagedAgentEntry } from '../../home/control-plane';
import { AddressChip } from '../../components/shared/AddressChip';

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
      description={agent
        ? 'What changed for this agent, when, and the audit reference behind it — the rows of your control-plane timeline that name it. The on-chain and vault records stay canonical.'
        : 'Your control-plane timeline: what changed, when, and the audit reference behind it. The on-chain and vault records stay canonical.'}
    >
      <div className="dash-section">
        <h2>Timeline</h2>
        {!loaded ? (
          <p className="manage-card-blurb">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="manage-card-blurb">
            {agent
              ? 'Nothing recorded for this agent yet. Releasing a card, publishing a projection, issuing a grant or changing its lifecycle all land here.'
              : 'Nothing recorded yet. Publishing your Home manifest, deciding an inbox request, revoking a delegation, or adding an agent all land here.'}
          </p>
        ) : (
          shown.map((e) => (
            <div key={e.auditRef} style={{ padding: '0.6rem 0', borderBottom: '1px solid var(--color-border)' }}>
              <b>{EVENT_COPY[e.eventType]}</b>
              <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                {new Date(e.at).toLocaleString()} · audit <code>{e.auditRef.slice(0, 8)}</code>
                {e.refs.length > 0 && (
                  <>
                    {' · '}
                    {e.refs.map((r, i) => (
                      <code key={i} style={{ marginRight: 4 }}>
                        {typeof r === 'object' && 'hash' in r ? `${r.kind} ${r.hash.slice(0, 10)}…` : 'ref'}
                      </code>
                    ))}
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {entries.length > 0 && (
        <div className="dash-section" style={{ marginTop: '1.5rem' }}>
          <h2>Managed agents (portable projection)</h2>
          <p className="manage-card-blurb">
            The <code>ManagedAgentEntryV1</code> rows any Home implementation would render for your tree.
          </p>
          {entries.map((m) => {
            const address = m.agent.match(/0x[0-9a-fA-F]{40}$/)?.[0] as `0x${string}` | undefined;
            return (
              <div key={m.agent} style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', padding: '0.45rem 0', borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap' }}>
                {address && <AddressChip address={address} size="sm" />}
                <span style={{ fontSize: '0.82rem', color: 'var(--color-text-body)' }}>
                  {m.agentType} · {m.relationship.replaceAll('_', ' ')} · control: <b>{m.controlGrade}</b> · {m.status}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </SectionShell>
  );
}

