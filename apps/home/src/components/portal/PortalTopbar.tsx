'use client';
// Persistent topbar: brand (shield + name, links home) + the workspace switcher (spec 315 —
// person / org / app, scopes the left nav) + the identity chip (who am I) on the right.
import { BrandShield } from '../shared/BrandShield';
import { IdentityChip } from './IdentityChip';
import { AgentSwitcher } from './AgentSwitcher';
import { WorkspaceAction } from './WorkspaceAction';
import { ChatIcon } from '../shared/Icons';

export function PortalTopbar({ brandName, askOpen, onToggleAsk }: { brandName: string; askOpen?: boolean; onToggleAsk?: () => void }) {
  return (
    <header className="portal-topbar" role="banner">
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', minWidth: 0 }}>
        <a className="portal-brand" href="/" aria-label={`${brandName} — your portal`}>
          <BrandShield size={26} />
          <span>{brandName}</span>
        </a>
        <AgentSwitcher />
        {/* Primary action for the selected workspace: person → Add organization; org → Invite member. */}
        <WorkspaceAction />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
        {/* Ask the realm you are standing in — the addressee follows the switcher, never a second picker. */}
        {onToggleAsk && (
          <button
            type="button" className={`portal-ask-btn${askOpen ? ' on' : ''}`} data-testid="ask-toggle"
            aria-label="Ask this agent" aria-pressed={!!askOpen} title="Ask this agent" onClick={onToggleAsk}
          >
            {/* LABELLED, like the workspace action beside it. A bare glyph in a circle asks the person to
                guess, and this control is the one place they can talk to the agent — it says what it is. */}
            <ChatIcon size={15} />
            <span>Ask</span>
          </button>
        )}
        <IdentityChip />
      </div>
    </header>
  );
}
