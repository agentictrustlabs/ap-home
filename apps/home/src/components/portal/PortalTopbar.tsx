'use client';
// Persistent topbar: brand (shield + name, links home) + the workspace switcher (spec 315 —
// person / org / app, scopes the left nav) + the identity chip (who am I) on the right.
import { BrandShield } from '../shared/BrandShield';
import { IdentityChip } from './IdentityChip';
import { AgentSwitcher } from './AgentSwitcher';

export function PortalTopbar({ brandName }: { brandName: string }) {
  return (
    <header className="portal-topbar" role="banner">
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', minWidth: 0 }}>
        <a className="portal-brand" href="/" aria-label={`${brandName} — your portal`}>
          <BrandShield size={26} />
          <span>{brandName}</span>
        </a>
        <AgentSwitcher />
      </div>
      <IdentityChip />
    </header>
  );
}
