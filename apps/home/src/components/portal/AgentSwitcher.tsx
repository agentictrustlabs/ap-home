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
import { parseWorkspacePath, orgHref, serviceHref, personaHref } from '../../lib/workspace';
import { agentClassOf, orgKindWordOf, kindWordOf, authorityLineage } from '../../lib/agent-class';
import { UserIcon, BuildingIcon, LandmarkIcon, CheckIcon } from '../shared/Icons';
import { nameLabel } from '../../lib/domain';
import { Popover } from '../shared/ui';
import { actingBasis } from '../../lib/acting-basis';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const lc = (s: string) => s.toLowerCase();

export function AgentSwitcher() {
  const { session, profile, agentAddress, agentName, personName } = useSession();
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
  // OTHER PEOPLE OF YOURS. They are person-class, so they matched neither filter above and the dropdown
  // showed one hardcoded row — "your home" — and then jumped to organizations. A custodian who had
  // chartered a second person could not see it anywhere, which is the same as not having it.
  const people = agents.filter((a) => agentClassOf(a.kind) === 'person');

  if (!session || !profile) return null;

  // The PROFILE name leads when the person gave one ("Rich Pedersen"); the handle is the fallback, and it
  // stays visible as the person row's sub-line so the canonical name is never hidden.
  const handleLabel = agentName ? nameLabel(agentName) : agentAddress ? short(agentAddress) : 'You';
  const personLabel = personName ?? handleLabel;
  const lineageFor = (a: (typeof agents)[number]) =>
    // The KIND WORD leads (workspace · you → …): every row answers "what class of agent is this"
    // in place, the same way org rows lead with organization/team.
    `${kindWordOf(a.kind)} · ${authorityLineage(a, agents, 'you', agentAddress ?? undefined)
      .map((n) => (n === 'you' || n === 'unnamed' ? n : nameLabel(n)))
      .join(' → ')}`;

  const activeOrg = active.kind === 'org' ? allOrgs.find((o) => lc(o.agent) === lc(active.org)) : undefined;
  const activeService = active.kind === 'service' ? services.find((t) => lc(t.agent) === lc(active.agent)) : undefined;
  const activePersona = active.kind === 'persona' ? people.find((p) => lc(p.agent) === lc(active.agent)) : undefined;
  const triggerName =
    active.kind === 'org' ? (activeOrg?.name ? nameLabel(activeOrg.name) : short(active.org))
    : active.kind === 'service' ? (activeService?.name ? nameLabel(activeService.name) : short(active.agent))
    // A PERSONA NAMES ITSELF IN THE TRIGGER. It used to fall through to `personLabel` — the connected
    // person — so selecting another of your names put THEIR name back in the button and the switch looked
    // as though it had been refused.
    : active.kind === 'persona' ? (activePersona?.name ? nameLabel(activePersona.name) : short(active.agent))
    : personLabel;
  // spec 318 / 398 §4.4: the caption states the RELATIONSHIP truthfully — a member org is authority-only (never
  // custody), an org not in the list at all is a guest visit — from the ONE function every basis line renders from.
  const caption = actingBasis({
    active, self: { address: agentAddress ?? '' }, classOf: (k) => agentClassOf(k as Parameters<typeof agentClassOf>[0]),
    // `name` too — `BasisLine` has always passed it and this did not, so every caption that names an agent
    // fell back to its generic: a persona read "acting as another name of yours" when it could have said
    // which, and a stewarded org read "acting for this agent".
    agents: agents.map((a) => ({ agent: a.agent, kind: a.kind, ...(a.name ? { name: nameLabel(a.name) } : {}), ...(a.relationship ? { relationship: a.relationship } : {}) })),
  }).caption;

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
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0, maxWidth: 200 }}>
              <span style={{ fontWeight: 650, fontSize: '.84rem', lineHeight: 1.15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}>
                {triggerName}
              </span>
              <span style={{ fontSize: '.66rem', opacity: 0.6, lineHeight: 1.1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 190 }}>{caption}</span>
            </span>
            <span aria-hidden style={{ opacity: 0.5, fontSize: '.7rem' }}>▾</span>
          </button>
        )}
      >
        {heading('Your smart agents')}
        <Row
          icon={<UserIcon size={17} />}
          title={personLabel}
          sub={personName && agentName ? `person · ${handleLabel}` : "person · your home"}
          activeRow={active.kind === 'person'}
          onClick={() => go('/')}
        />

        {/* EACH IS A NAME OF YOURS, not something you look after: the caption says whose vault it is rather
            than the "you → …" lineage an org row carries, because there is no chain of authority to draw
            between you and yourself. */}
        {people.length > 0 && heading('Other people of yours')}
        {people.map((who) => (
          <Row
            key={who.agent}
            icon={<UserIcon size={17} />}
            title={who.name ? nameLabel(who.name) : short(who.agent)}
            sub="person · a name of yours, with its own vault"
            activeRow={active.kind === 'persona' && lc(active.agent) === lc(who.agent)}
            // SWITCHING TO A NAME OF YOURS, not going to look at a list of them. This row sent everybody to
            // `/agents?kind=person` — the index — which is not a workspace path, so the switcher re-derived
            // `person` from the URL and put the connected person back in the trigger: picking a persona
            // selected the default instead of it.
            onClick={() => go(personaHref(who.agent))}
          />
        ))}

        {orgs.length > 0 && heading('Organizations you steward')}
        {orgs.map((o) => (
          <Row
            key={o.agent}
            icon={<BuildingIcon size={17} />}
            title={o.name ? nameLabel(o.name) : short(o.agent)}
            sub={`${orgKindWordOf(o.kind)} · you → ${o.name ? nameLabel(o.name) : 'unnamed'}`}
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
            sub={`${orgKindWordOf(o.kind)} · member (no custody)`}
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
          onClick={() => go('/agents')}
          style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '.45rem .6rem', minHeight: 0,
            background: 'transparent', border: 'none', color: 'var(--color-amber-700)', fontWeight: 600, fontSize: '.82rem', cursor: 'pointer',
          }}
        >
          Create an organization or service
        </button>
      </Popover>
    </div>
  );
}
