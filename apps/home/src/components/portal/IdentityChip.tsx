'use client';
// Topbar identity chip → the USER MENU (spec 348 §4). Everything here is about the signed-in person and
// the deployment — Your profile, Security, Connected, Your apps, Network — not about the agent whose
// workspace is open. They used to sit in the left nav, which put "your passkeys" and "this workspace's
// records" in the same list under the same heading.
//
// Network is here rather than per-agent on purpose: it is ONE substrate for every agent, and a per-agent
// item for a non-per-agent fact invents a distinction that does not exist.
//
// Behaviour (outside-click + ESC dismiss, focus return) comes from the shared Popover; the panel keeps
// its own `.identity-popover` styling.
import { useSession } from '../../context/session';
import { whitelabel } from '../../whitelabel/config';
import { buildUserMenu } from './nav';
import { AddressChip } from '../shared/AddressChip';
import { ChevronDownIcon } from '../shared/Icons';
import { Popover } from '../shared/ui';

export function IdentityChip() {
  const { agentName, agentAddress, signOut } = useSession();

  return (
    <div className="identity-chip-wrap">
      <Popover
        role="menu"
        panelClassName="identity-popover"
        trigger={(p) => (
          <button type="button" className="identity-chip" {...p}>
            <span className="identity-chip-name">{agentName ?? 'Your portal'}</span>
            <ChevronDownIcon size={16} />
          </button>
        )}
      >
        <div className="identity-popover-name">{agentName ?? '—'}</div>
        {agentAddress && <AddressChip address={agentAddress} size="sm" />}
        {/* SIGN OUT SITS UNDER THE NAME, first. It used to be last, after every menu link — and in the
            sidebar-foot placement the menu opens UPWARD, so a long list pushed the one item people came
            for off the top. The way out of a session should never require scrolling to find. */}
        <button type="button" className="identity-popover-item danger" role="menuitem" data-testid="identity-signout" onClick={signOut}>
          Sign out
        </button>
        <div className="identity-popover-divider" />
        <a className="identity-popover-item" href="/" role="menuitem">View your portal</a>
        {buildUserMenu(whitelabel).map((item) => (
          <a key={item.id} className="identity-popover-item" href={item.href} role="menuitem">{item.label}</a>
        ))}
        <a className="identity-popover-item" href="/names" role="menuitem">Registered names</a>
      </Popover>
    </div>
  );
}
