'use client';
// Persistent topbar: brand (shield + name, links home) + the workspace switcher (spec 315 —
// person / org / app, scopes the left nav) + the identity chip (who am I) on the right.
import { BrandShield } from '../shared/BrandShield';
import { IdentityChip } from './IdentityChip';
import { AgentSwitcher } from './AgentSwitcher';
import { WorkspaceAction } from './WorkspaceAction';
import { ChatIcon } from '../shared/Icons';

// On a phone the bar carries FOUR things and no more: the shield (home), the workspace you stand in, Ask,
// and a small identity chip whose menu holds Sign out. The brand name and the workspace action are desktop
// furniture — with them, the Ask button was the thing squeezed off a 390px screen (`.portal-topbar-*` rules
// in globals.css).
export function PortalTopbar({ brandName, askOpen, onToggleAsk }: { brandName: string; askOpen?: boolean; onToggleAsk?: () => void }) {
  return (
    <header className="portal-topbar" role="banner">
      <div className="portal-topbar-l">
        <a className="portal-brand" href="/" aria-label={`${brandName} — your portal`}>
          <BrandShield size={26} />
          <span className="portal-brand-name">{brandName}</span>
        </a>
        <AgentSwitcher />
        {/* Primary action for the selected workspace: person → Add organization; org → Invite member. */}
        <span className="portal-topbar-action"><WorkspaceAction /></span>
      </div>
      <div className="portal-topbar-r">
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
