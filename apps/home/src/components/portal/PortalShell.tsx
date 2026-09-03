'use client';
// The authenticated portal chrome: topbar (brand + workspace switcher + identity) + sidebar
// (desktop) / bottom-nav (mobile) + the routed section as <main>. The active WORKSPACE is
// derived from the URL (spec 315) and scopes the left nav: person / org / connected app.
import { useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { whitelabel } from '../../whitelabel/config';
import { useSession } from '../../context/session';
import { useManagedAgents } from './ManagedAgents';
import { parseWorkspacePath, orgHref } from '../../lib/workspace';
import { orgStatusOf, STATUS_LABEL } from '../../lib/org-lifecycle';
import { buildNav, buildSettingsPane, paneGroups, bottomNav } from './nav';
import { useRegisteredName } from '../../lib/reverse-name';
import { PortalTopbar } from './PortalTopbar';
import { AskFlyout } from './ask/AskFlyout';
import { askIsAvailable } from '../../home/ask';
import { PortalSidebar } from './PortalSidebar';
import { PortalBottomNav } from './PortalBottomNav';
import { useInboxView } from '../../home/use-inbox';
import { nameLabel } from '../../lib/domain';

export function PortalShell({ children, appsBadge }: { children: ReactNode; appsBadge?: number }) {
  const [askOpen, setAskOpen] = useState(false);
  const pathname = usePathname();
  const active = parseWorkspacePath(pathname ?? '/');
  const { session, agentAddress, agentName } = useSession();
  // 'any' (spec 342): the shell must name and route the workspace the URL points at, whatever the
  // org's lifecycle status — a deactivated org is hidden from lists, not made unreachable.
  const { agents } = useManagedAgents(session?.token ?? null, 'any');
  const { view } = useInboxView(active.kind === 'person' ? session : null);
  const inboxUnread = active.kind === 'person' ? (view?.summary.unreadTotal ?? 0) : 0;
  const activeAgent = active.kind === 'org'
    ? agents.find((a) => a.agent.toLowerCase() === active.org.toLowerCase())
    : active.kind === 'service'
      ? agents.find((a) => a.agent.toLowerCase() === active.agent.toLowerCase())
      : undefined;
  const rel = active.kind === 'org' ? (activeAgent?.relationship ?? 'member') : 'steward';
  const workspaceName = activeAgent?.name ? nameLabel(activeAgent.name) : undefined;
  // An organization coordinates people by definition; a service agent does when it is a WORKSPACE. A
  // treasury or a registry has no roster, and a Members page that is always empty teaches nothing.
  const hasMembers = active.kind === 'org' || (active.kind === 'service' && activeAgent?.kind === 'workspace');
  const groups = buildNav(whitelabel, {
    apps: appsBadge,
    inbox: inboxUnread > 0 ? inboxUnread : undefined,
  }, active, rel, workspaceName, hasMembers);
  // "Has a name" means the NAMING SERVICE resolves to this agent — not that the managed-agent row has a
  // label. A workspace's row says "Northern Colorado Field", which is a display label and not a name
  // anything can resolve; keying off it would call a nameless agent named.
  const activeSa = active.kind === 'org' ? active.org : active.kind === 'service' ? active.agent : agentAddress;
  const registered = useRegisteredName((activeSa ?? null) as `0x${string}` | null);
  const hasName = active.kind === 'person' ? !!agentName : (!registered.loaded || !!registered.name);
  const panes = {
    stewardship: paneGroups('stewardship', active, rel),
    settings: buildSettingsPane(active, rel, hasName),
  };
  const tabs = bottomNav(groups);
  // spec 342 — the workspace of a deactivated or deleted org still opens (a hidden row is a view
  // decision, not a locked door), but it must SAY why it is missing from everywhere else.
  const orgStatus = active.kind === 'org' && activeAgent ? orgStatusOf(activeAgent) : 'active';
  // THE ASK (spec 350 §3.5) — addressed to the realm you are standing in, which is the same scope the
  // sidebar uses. The person's own realm is their SA; an org's or a service's is the one in the URL.
  const askAddressee = (active.kind === 'person' ? agentAddress : activeSa) as `0x${string}` | null;
  const askLabel = active.kind === 'person'
    ? (agentName ? nameLabel(agentName) : 'your agent')
    : (workspaceName ?? (activeAgent?.name ? nameLabel(activeAgent.name) : undefined) ?? 'this workspace');
  // The Ask needs the harness, and the harness needs the enforcer that binds a mandate to ONE request.
  // Where that is not deployed (Base Sepolia today), there is no Ask — not a button that fails when
  // pressed. One signal, read from the deployment this build targets.
  const canAsk = !!session && !!askAddressee && askIsAvailable();
  return (
    <div className="portal-root">
      <PortalTopbar brandName={whitelabel.brand.name} {...(canAsk ? { askOpen, onToggleAsk: () => setAskOpen((v) => !v) } : {})} />
      <div className="portal-body">
        <PortalSidebar groups={groups} panes={panes} workspaceName={workspaceName} />
        <main className="portal-main">
          {orgStatus !== 'active' && active.kind === 'org' && (
            <div
              role="status"
              style={{
                margin: '0 0 1rem', padding: '.6rem .8rem', borderRadius: 10, fontSize: '.85rem',
                background: 'var(--color-amber-50, #fffbeb)', color: 'var(--color-amber-800, #92400e)',
                border: '1px solid var(--color-amber-200, #fde68a)',
              }}
            >
              This organization is <b>{STATUS_LABEL[orgStatus].toLowerCase()}</b> — hidden from the rest of your
              home. Its records, address and delegations are untouched. Change that under{' '}
              <a href={orgHref(active.org, 'status')}>Settings → Status</a>.
            </div>
          )}
          {children}
        </main>
      </div>
      <PortalBottomNav groups={groups} tabs={tabs} panes={panes} workspaceName={workspaceName} />
      {askOpen && canAsk && <AskFlyout addressee={askAddressee!} addresseeLabel={askLabel} onClose={() => setAskOpen(false)} />}
    </div>
  );
}
