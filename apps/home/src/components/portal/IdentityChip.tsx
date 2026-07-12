'use client';
// Topbar identity chip → popover (name, address, view portal, sign out). Behaviour (outside-click + ESC
// dismiss, focus return) comes from the shared Popover; the panel keeps its own `.identity-popover` styling.
import { useSession } from '../../context/session';
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
        <div className="identity-popover-divider" />
        <a className="identity-popover-item" href="/" role="menuitem">View your portal</a>
        <a className="identity-popover-item" href="/names" role="menuitem">Registered names</a>
        <button type="button" className="identity-popover-item danger" role="menuitem" onClick={signOut}>
          Sign out
        </button>
      </Popover>
    </div>
  );
}
