'use client';
// The WORKSPACE switcher (spec 315) — sits right of the site name in the topbar, ported from the
// impact home's ContextSwitcher. Lists ONLY the custodial smart agents the connected person is
// responsible for: you (the person SA), the organizations you steward, and the treasuries you
// manage. Selecting one scopes the left nav to that agent's actions; switching = navigating (the
// shell derives the active workspace from the URL). Connected apps are external grants — no
// custody — and live in the person nav (/apps), never here. Identity (who am I) stays in the
// top-right chip; this menu answers "where am I acting".
import { useMemo, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useSession } from '../../context/session';
import { useManagedAgents } from './ManagedAgents';
import { parseWorkspacePath, orgHref, treasuryHref } from '../../lib/workspace';
import { UserIcon, BuildingIcon, LandmarkIcon, CheckIcon } from '../shared/Icons';
import { nameLabel } from '../../lib/domain';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const lc = (s: string) => s.toLowerCase();

export function AgentSwitcher() {
  const { session, profile, agentAddress, agentName } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { agents } = useManagedAgents(session?.token ?? null);

  const active = useMemo(() => parseWorkspacePath(pathname ?? '/'), [pathname]);
  const orgs = agents.filter((a) => a.kind === 'org');
  const treasuries = agents.filter((a) => a.kind === 'person-treasury' || a.kind === 'org-treasury');
  const orgNameFor = (parent: string) => orgs.find((o) => lc(o.agent) === lc(parent))?.name;

  if (!session || !profile) return null;

  const personLabel = agentName ? nameLabel(agentName) : agentAddress ? short(agentAddress) : 'You';
  const activeOrg = active.kind === 'org' ? orgs.find((o) => lc(o.agent) === lc(active.org)) : undefined;
  const activeTreasury = active.kind === 'treasury' ? treasuries.find((t) => lc(t.agent) === lc(active.agent)) : undefined;
  const triggerName =
    active.kind === 'org' ? (activeOrg?.name ? nameLabel(activeOrg.name) : short(active.org))
    : active.kind === 'treasury' ? (activeTreasury?.name ? nameLabel(activeTreasury.name) : short(active.agent))
    : personLabel;
  const caption = active.kind === 'person' ? 'acting as you' : 'acting as custodian';

  const go = (href: string) => { router.push(href); setOpen(false); };

  const Row = ({ icon, title, sub, activeRow, onClick }: {
    icon: React.ReactNode; title: string; sub: string; activeRow: boolean; onClick: () => void;
  }) => (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '.55rem', width: '100%', textAlign: 'left',
        padding: '.5rem .6rem', border: 'none', borderRadius: 8, minHeight: 0,
        background: activeRow ? '#eef2ff' : 'transparent', color: '#111827', cursor: 'pointer', fontWeight: 400,
      }}
    >
      {icon}
      <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 600, fontSize: '.85rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
        <span style={{ fontSize: '.7rem', opacity: 0.6 }}>{sub}</span>
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
    <div style={{ position: 'relative', marginLeft: '.35rem' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Switch workspace"
        style={{
          display: 'flex', alignItems: 'center', gap: '.5rem', padding: '.3rem .6rem', minHeight: 0,
          background: 'transparent', border: '1px solid #e5e7eb', borderRadius: 8, color: '#111827',
          cursor: 'pointer', fontWeight: 400, maxWidth: 260,
        }}
      >
        {active.kind === 'org' ? <BuildingIcon size={16} /> : active.kind === 'treasury' ? <LandmarkIcon size={16} /> : <UserIcon size={16} />}
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
          <span style={{ fontWeight: 650, fontSize: '.84rem', lineHeight: 1.15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}>
            {triggerName}
          </span>
          <span style={{ fontSize: '.66rem', opacity: 0.6, lineHeight: 1.1 }}>{caption}</span>
        </span>
        <span aria-hidden style={{ opacity: 0.5, fontSize: '.7rem' }}>▾</span>
      </button>

      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
          <div
            style={{
              position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 41, width: 290,
              background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 10px 30px rgba(0,0,0,.12)',
              padding: '.4rem', maxHeight: '70vh', overflowY: 'auto',
            }}
          >
            {heading('Your smart agents')}
            <Row
              icon={<UserIcon size={17} />}
              title={personLabel}
              sub="your personal home"
              activeRow={active.kind === 'person'}
              onClick={() => go('/you')}
            />

            {orgs.length > 0 && heading('Organizations you steward')}
            {orgs.map((o) => (
              <Row
                key={o.agent}
                icon={<BuildingIcon size={17} />}
                title={o.name ? nameLabel(o.name) : short(o.agent)}
                sub={o.name ? 'organization · custodied by you' : 'unnamed organization'}
                activeRow={active.kind === 'org' && lc(active.org) === lc(o.agent)}
                onClick={() => go(orgHref(o.agent, 'overview'))}
              />
            ))}

            {treasuries.length > 0 && heading('Treasuries you manage')}
            {treasuries.map((t) => {
              const parentOrg = t.kind === 'org-treasury' ? orgNameFor(t.parent) : undefined;
              return (
                <Row
                  key={t.agent}
                  icon={<LandmarkIcon size={17} />}
                  title={t.name ? nameLabel(t.name) : short(t.agent)}
                  sub={t.kind === 'person-treasury' ? 'personal treasury' : `treasury of ${parentOrg ? nameLabel(parentOrg) : 'an organization'}`}
                  activeRow={active.kind === 'treasury' && lc(active.agent) === lc(t.agent)}
                  onClick={() => go(treasuryHref(t.agent))}
                />
              );
            })}

            <div style={{ borderTop: '1px solid #f1f5f9', margin: '.4rem 0' }} />
            <button
              onClick={() => go('/organizations')}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '.45rem .6rem', minHeight: 0,
                background: 'transparent', border: 'none', color: '#4338ca', fontWeight: 600, fontSize: '.82rem', cursor: 'pointer',
              }}
            >
              ＋ Create an organization or treasury
            </button>
          </div>
        </>
      )}
    </div>
  );
}
