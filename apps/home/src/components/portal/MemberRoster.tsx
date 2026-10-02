'use client';
// MEMBERS — who is in this organization and how to reach them (design system v2, 2026-09-13). A ROSTER: one row per
// member with their mark, their name and public name, what kind of participant they are, the responsibility they
// carry, and what they may read here — searchable, filterable by kind; a row opens the member's contract (spec 398
// §4.5: type · sponsor · responsibility · permissions · active work) in a drawer, and hands them to the Ask as its
// selection (361 I6). Managing membership is Settings → Membership; this is the participation view.
//
// A WORKSPACE'S MEMBERS ARE ITS GOVERNOR'S (the owner's rule, 2026-10-02; `org.ttl` §2): a `.workspace` agent is a
// service that coordinates a workspace and holds no members; who belongs is the organization that governs it. So
// for a workspace this page resolves the governor — the viewer's own link to the workspace names it as `parent`,
// and a steward with the workspace's wire can read the `workspace.governor` pointer out of its vault — and reads
// the roster THERE, saying so in one line. A workspace with no governor (paired before the rule) reads its own.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../../context/session';
import { SectionShell } from './SectionShell';
import { fetchWorkspaceRoster, workspaceGovernorOf, type RosterMember } from '../../lib/recipient-directory';
import { useManagedAgents } from './ManagedAgents';
import { vaultReadWithDelegation } from '../../lib/vault-client';
import type { DelegationWire } from '../../lib/delegation';
import { nameLabel } from '../../lib/domain';
import { AddressChip } from '../shared/AddressChip';
import { setAskSelection } from '../../home/ask-selection';
import { rosterRows, type RosterRow } from '../../home/roster-contract';
import { fetchWorkList } from '../../lib/work-client';
import { List, Row, KeyValue, ErrorNote, LinkButton, Panel, Stats, Stat, SearchInput, FilterChip, Avatar, Chip, Drawer, Button, type PanelState } from '../../ui';
import { InboxIcon } from './today-icons';

type KindFilter = 'all' | 'person' | 'agent';
// agent-vocabulary.md §1: the two kinds a roster holds beside people are SERVICES (a runtime, a coach, a treasury) and
// organizations (a team); the filter's word is Services — never "agents", which every member is.
const isAgentType = (t: string) => t === 'service' || t === 'organization';
const typeWords = (t: string) => (t === 'unknown' ? 'member' : t.replace(/[_-]+/g, ' '));

export function MemberRoster({ agent, title = 'Members' }: { agent: string; title?: string }) {
  const { session, agentAddress } = useSession();
  // 'any': the roster of a deactivated org still opens from its URL (spec 342), and the governor of a workspace
  // must be findable whatever its lifecycle row says.
  const { agents: managed, loaded: managedLoaded } = useManagedAgents(session?.token ?? null, 'any');
  const [members, setMembers] = useState<RosterMember[] | null>(null);
  /** Whose records the roster is: the governing organization (address + name), or null for an organization's own
   *  page and for a legacy workspace reading its own. */
  const [heldBy, setHeldBy] = useState<{ agent: string; name: string } | null>(null);
  const [executors, setExecutors] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');

  const row = managed.find((a) => a.agent.toLowerCase() === agent.toLowerCase());
  const load = useCallback(async () => {
    if (!session?.token || !managedLoaded) return;
    setError(null);
    try {
      // THE GOVERNOR, cheapest door first: the viewer's own link (`parent`, no request); then, for a steward holding
      // the workspace's wire, the pointer in the workspace's vault — the vault read this app already makes for an
      // agent the person stewards. A member without the wire and without a parent link reads the workspace itself.
      let governor = workspaceGovernorOf(row, managed);
      if (!governor && row?.kind === 'workspace' && row.stewardshipDelegation) {
        const ptr = await vaultReadWithDelegation<{ governedBy?: string }>(row.stewardshipDelegation as DelegationWire, 'workspace.governor').catch(() => null);
        const g = String(ptr?.governedBy ?? '').toLowerCase();
        governor = /^0x[0-9a-f]{40}$/.test(g) && g !== agent.toLowerCase() ? g : null;
      }
      const roster = await fetchWorkspaceRoster(session.token, agent, row?.kind === 'workspace' ? governor : null);
      setMembers(roster.members);
      const gov = roster.governedBy ? managed.find((a) => a.agent.toLowerCase() === roster.governedBy) : undefined;
      setHeldBy(roster.governedBy ? { agent: roster.governedBy, name: gov?.name ? nameLabel(gov.name) : `${roster.governedBy.slice(0, 6)}…${roster.governedBy.slice(-4)}` } : null);
      const w = await fetchWorkList(session.token, agent).catch(() => null);
      const counts = new Map<string, number>();
      const me = (agentAddress ?? '').toLowerCase();
      if (me) counts.set(me, (w?.mine?.allocations?.length ?? 0) + (w?.mine?.commitments ?? []).filter((c) => c.status === 'active').length);
      setExecutors(counts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMembers([]);
    }
  }, [session?.token, agent, agentAddress, managedLoaded, row, managed]);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => (members ? rosterRows({ members, executors }) : []), [members, executors]);
  const agents = rows.filter((m) => isAgentType(m.type)).length;
  const stewards = rows.filter((m) => /steward|custodian|founder/i.test(`${m.role ?? ''} ${m.responsibility ?? ''}`)).length;
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((m) => (kind === 'all' || (kind === 'agent') === isAgentType(m.type)) && (!needle || `${m.displayName} ${m.publicName ?? ''} ${m.role ?? ''} ${m.responsibility ?? ''} ${m.address}`.toLowerCase().includes(needle)));
  const open = selected ? rows.find((m) => m.address.toLowerCase() === selected) ?? null : null;
  const state: PanelState = members === null ? 'loading' : shown.length ? 'ready' : 'empty';

  if (!session) return <SectionShell title={title}><Panel title={title} state="empty" empty={{ title: 'Not signed in' }} /></SectionShell>;

  const pick = (m: RosterRow) => {
    const next = selected === m.address.toLowerCase() ? null : m.address.toLowerCase();
    setSelected(next);
    setAskSelection(next ? { entity: next as `0x${string}`, kind: 'person', label: m.displayName } : null);
  };

  return (
    <SectionShell title={title} description={<>The people and services in this workspace and how to reach them. Who belongs is decided under Settings → Membership.</>}>
      {error && <ErrorNote>{error}</ErrorNote>}
      {heldBy && (
        // The line that says WHOSE records these are: a workspace agent coordinates and holds no members; the
        // organization governing it does. A link, because that is where membership is managed.
        <p className="ui-note" data-testid="roster-held-by">
          Membership is held by <a href={`/org/${heldBy.agent}/members`}>{heldBy.name}</a> (this workspace&apos;s organization).
        </p>
      )}
      <Stats>
        <Stat label="Members" value={rows.length} loading={members === null} hint="people and services admitted" />
        <Stat label="Services" value={agents} loading={members === null} hint="runtimes, coaches, treasuries" />
        <Stat label="Stewards" value={stewards} loading={members === null} hint="who may act for the organization" />
      </Stats>
      <div className="ui-toolbar">
        <SearchInput placeholder="Search members…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search members" />
        <div style={{ display: 'flex', gap: 6 }}>
          <FilterChip active={kind === 'all'} onClick={() => setKind('all')}>All</FilterChip>
          <FilterChip active={kind === 'person'} count={members ? rows.length - agents : undefined} onClick={() => setKind('person')}>People</FilterChip>
          <FilterChip active={kind === 'agent'} count={members ? agents : undefined} onClick={() => setKind('agent')}>Services</FilterChip>
        </div>
        {/* Spec 400 W1b — the Members-panel shortcut: pair your own runtime (Claude Code, goose) as a member of this
            workspace. The ceremony lives on your Contacts → Your runtimes; this is the door from where the roster is. */}
        <LinkButton size="sm" href="/contacts#runtimes" title="Pair your own Claude Code or goose as a member — a code from your Home, your signatures">Add a runtime</LinkButton>
      </div>
      <Panel title="Roster" icon={<InboxIcon />} count={shown.length} state={state} rows={5} lead testId="roster"
        empty={{ title: needle || kind !== 'all' ? 'No member matches' : 'No members yet', hint: needle || kind !== 'all' ? 'Clear the search or the filter.' : 'Invite someone under Settings → Membership; they appear here once they accept.' }}>
        <List>
          {shown.map((m) => {
            const you = !!agentAddress && m.address.toLowerCase() === agentAddress.toLowerCase();
            const picked = selected === m.address.toLowerCase();
            const isAgent = isAgentType(m.type);
            return (
              <div key={m.address} className="ui-row" role="button" tabIndex={0} aria-pressed={picked} data-testid={`member-${m.address}`}
                onClick={() => pick(m)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(m); } }}
                style={{ cursor: 'pointer', ...(picked ? { background: 'var(--st-accent-bg)', boxShadow: 'inset 3px 0 0 var(--color-action)' } : {}) }}>
                <div className="ui-row-lead"><Avatar name={m.publicName ?? m.displayName} address={m.address} agent={isAgent} /></div>
                <div className="ui-row-main">
                  <div className="ui-row-title" style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    {m.displayName}{you && <Chip>you</Chip>}
                    {m.publicName && <span className="ui-meta">{m.publicName}</span>}
                  </div>
                  <div className="ui-row-meta" data-testid={`member-facets-${m.address}`}>
                    {typeWords(m.type)}{m.responsibility ? ` · ${m.responsibility}` : ''}{m.kin ? ` · ${m.kin}` : ''}{m.role && m.role !== 'member' ? ` · ${m.role}` : ''} · {m.permissions.length > 60 ? `${m.permissions.slice(0, 57)}…` : m.permissions}
                  </div>
                </div>
                <div className="ui-row-side">
                  {isAgent && <Chip>agent</Chip>}
                  {you && m.activeWork > 0 && <Chip tone="ok">{m.activeWork} active</Chip>}
                  {!you && <LinkButton size="sm" href={`/messages?to=${m.address}`} onClick={(e) => e.stopPropagation()}>Message</LinkButton>}
                </div>
              </div>
            );
          })}
        </List>
      </Panel>
      {open && (
        <Drawer title={<span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}><Avatar name={open.publicName ?? open.displayName} address={open.address} agent={isAgentType(open.type)} size="sm" />{open.displayName}</span>} onClose={() => { setSelected(null); setAskSelection(null); }}
          actions={!(agentAddress && open.address.toLowerCase() === agentAddress.toLowerCase()) ? <LinkButton size="sm" variant="primary" href={`/messages?to=${open.address}`}>Message</LinkButton> : undefined}>
          <div style={{ marginBottom: 'var(--sp-4)' }}><AddressChip address={open.address as `0x${string}`} size="sm" /></div>
          {/* Spec 398 §4.5 — the roster contract: type · sponsor · responsibility · permissions · active work. */}
          <div className="ui-card ui-card--quiet" data-testid={`member-contract-${open.address}`}>
            <KeyValue rows={[
              ['Type', typeWords(open.type), { absent: open.type === 'unknown' }],
              ['Public name', open.publicName ?? 'none', { absent: !open.publicName }],
              ['Sponsor', open.sponsor],
              ['Responsibility', open.responsibility ?? 'none assigned', { absent: !open.responsibility }],
              ['Permissions', open.permissions],
              ['Active work', agentAddress && open.address.toLowerCase() === agentAddress.toLowerCase() ? (open.activeWork === 0 ? 'none' : `${open.activeWork} item${open.activeWork === 1 ? '' : 's'}`) : 'not visible to you — their own view', { absent: !(agentAddress && open.address.toLowerCase() === agentAddress.toLowerCase()) }],
            ]} />
          </div>
          <p className="ui-note" style={{ marginTop: 'var(--sp-4)' }}>Selected for the Ask: a command from this page names this member. <Button size="sm" variant="ghost" onClick={() => { setSelected(null); setAskSelection(null); }}>Clear</Button></p>
        </Drawer>
      )}
    </SectionShell>
  );
}
