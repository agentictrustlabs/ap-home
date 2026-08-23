'use client';
// The WORKSPACE switcher (spec 315) — sits right of the site name in the topbar, ported from the
// impact home's ContextSwitcher. Lists ONLY the custodial smart agents the connected person is
// responsible for, grouped by the ADR-0046 classification (PROV-O trichotomy): YOU (person), the
// ORGANIZATIONS you steward, and the SERVICES you manage (treasury is a service ROLE — any future
// service-class agent lands in the same group). Under each service's name we render its authority
// lineage — the custody chain it was spawned under (you → treasury vs you → org → treasury) — so
// a person's service and an org's service read differently at a glance. Selecting a workspace
// scopes the left nav; switching = navigating (the shell derives the scope from the URL).
// Connected apps are external grants with no custody — they stay in the person nav (/apps).
import { useMemo, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useSession } from '../../context/session';
import { useManagedAgents } from './ManagedAgents';
import { parseWorkspacePath, orgHref, serviceHref } from '../../lib/workspace';
import { agentClassOf, serviceRoleOf, authorityLineage } from '../../lib/agent-class';
import { UserIcon, BuildingIcon, LandmarkIcon, CheckIcon } from '../shared/Icons';
import { nameLabel } from '../../lib/domain';
import { Popover } from '../shared/ui';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const lc = (s: string) => s.toLowerCase();

export function AgentSwitcher() {
  const { session, profile, agentAddress, agentName } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { agents } = useManagedAgents(session?.token ?? null);

  const active = useMemo(() => parseWorkspacePath(pathname ?? '/'), [pathname]);
  const allOrgs = agents.filter((a) => agentClassOf(a.kind) === 'org');
  // spec 318: custody vs membership are DIFFERENT relations — stewarded orgs (you control them)
  // vs orgs you belong to (authority-only: channels + visibility, no custody).
  const orgs = allOrgs.filter((a) => a.relationship !== 'member');
  const memberOrgs = allOrgs.filter((a) => a.relationship === 'member');
  const services = agents.filter((a) => agentClassOf(a.kind) === 'service');

  if (!session || !profile) return null;

  const personLabel = agentName ? nameLabel(agentName) : agentAddress ? short(agentAddress) : 'You';
  const lineageFor = (a: (typeof agents)[number]) =>
    [...authorityLineage(a, agents, 'you', agentAddress ?? undefined).map((n) => (n === 'you' || n === 'unnamed' ? n : nameLabel(n))), serviceRoleOf(a.kind)].join(' → ');

  const activeOrg = active.kind === 'org' ? allOrgs.find((o) => lc(o.agent) === lc(active.org)) : undefined;
  const activeService = active.kind === 'service' ? services.find((t) => lc(t.agent) === lc(active.agent)) : undefined;
  const triggerName =
    active.kind === 'org' ? (activeOrg?.name ? nameLabel(activeOrg.name) : short(active.org))
    : active.kind === 'service' ? (activeService?.name ? nameLabel(activeService.name) : short(active.agent))
    : personLabel;
  // spec 318: the caption states the RELATIONSHIP truthfully — a member org is authority-only
  // (never custody), and an org not in the list at all is a guest visit.
  const caption =
    active.kind === 'person' ? 'acting as you'
    : active.kind === 'org' && activeOrg?.relationship === 'member' ? 'member · no custody'
    : active.kind === 'org' && !activeOrg ? 'visiting · no custody'
    : 'acting as custodian';

  const go = (href: string) => { router.push(href); setOpen(false); };

  const Row = ({ icon, title, sub, activeRow, onClick }: {
    icon: React.ReactNode; title: string; sub: string; activeRow: boolean; onClick: () => void;
  }) => (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '.55rem', width: '100%', textAlign: 'left',
        padding: '.5rem .6rem', border: 'none', borderRadius: 8, minHeight: 0,
        background: activeRow ? 'var(--color-amber-50)' : 'transparent',
        color: activeRow ? 'var(--color-amber-800)' : 'var(--color-text-primary)',
        cursor: 'pointer', fontWeight: 400,
      }}
    >
      {icon}
      <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 600, fontSize: '.85rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
        <span style={{ fontSize: '.7rem', opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</span>
      </span>
      {activeRow && <CheckIcon size={15} />}
    </button>
  );

  const heading = (text: string) => (
    <div style={{ fontSize: '.66rem', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', opacity: 0.55, padding: '.5rem .6rem .15rem' }}>
      {text}
    </div>
  );

  return (
    <div style={{ marginLeft: '.35rem' }}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        panelStyle={{ width: 300, maxHeight: '70vh', overflowY: 'auto' }}
        trigger={(p) => (
          <button
            {...p}
            aria-label="Switch workspace"
            style={{
              display: 'flex', alignItems: 'center', gap: '.5rem', padding: '.3rem .6rem', minHeight: 0,
              background: 'var(--color-surface)', border: '1px solid var(--color-border-strong)', borderRadius: 8,
              color: 'var(--color-text-primary)', cursor: 'pointer', fontWeight: 400, maxWidth: 260,
            }}
          >
            {active.kind === 'org' ? <BuildingIcon size={16} /> : active.kind === 'service' ? <LandmarkIcon size={16} /> : <UserIcon size={16} />}
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
              <span style={{ fontWeight: 650, fontSize: '.84rem', lineHeight: 1.15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}>
                {triggerName}
              </span>
              <span style={{ fontSize: '.66rem', opacity: 0.6, lineHeight: 1.1 }}>{caption}</span>
            </span>
            <span aria-hidden style={{ opacity: 0.5, fontSize: '.7rem' }}>▾</span>
          </button>
        )}
      >
        {heading('Your smart agents')}
        <Row
          icon={<UserIcon size={17} />}
          title={personLabel}
          sub="person · your home"
          activeRow={active.kind === 'person'}
          onClick={() => go('/you')}
        />

        {orgs.length > 0 && heading('Organizations you steward')}
        {orgs.map((o) => (
          <Row
            key={o.agent}
            icon={<BuildingIcon size={17} />}
            title={o.name ? nameLabel(o.name) : short(o.agent)}
            sub={`organization · you → ${o.name ? nameLabel(o.name) : 'unnamed'}`}
            activeRow={active.kind === 'org' && lc(active.org) === lc(o.agent)}
            onClick={() => go(orgHref(o.agent, 'overview'))}
          />
        ))}

        {memberOrgs.length > 0 && heading('Organizations you belong to')}
        {memberOrgs.map((o) => (
          <Row
            key={o.agent}
            icon={<BuildingIcon size={17} />}
            title={o.name ? nameLabel(o.name) : short(o.agent)}
            sub="organization · member (no custody)"
            activeRow={active.kind === 'org' && lc(active.org) === lc(o.agent)}
            onClick={() => go(orgHref(o.agent, 'discussions'))}
          />
        ))}

        {services.length > 0 && heading('Services you manage')}
        {services.map((t) => (
          <Row
            key={t.agent}
            icon={<LandmarkIcon size={17} />}
            title={t.name ? nameLabel(t.name) : short(t.agent)}
            sub={lineageFor(t)}
            activeRow={active.kind === 'service' && lc(active.agent) === lc(t.agent)}
            onClick={() => go(serviceHref(t.agent))}
          />
        ))}

        <div style={{ borderTop: '1px solid var(--color-border)', margin: '.4rem 0' }} />
        <button
          onClick={() => go('/organizations')}
          style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '.45rem .6rem', minHeight: 0,
            background: 'transparent', border: 'none', color: 'var(--color-amber-700)', fontWeight: 600, fontSize: '.82rem', cursor: 'pointer',
          }}
        >
          ＋ Create an organization or service
        </button>
      </Popover>
    </div>
  );
}
