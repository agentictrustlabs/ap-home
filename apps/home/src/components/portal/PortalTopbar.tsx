'use client';
// Persistent topbar: brand (shield + name, links home) + the identity chip.
import { BrandShield } from '../shared/BrandShield';
import { IdentityChip } from './IdentityChip';

export function PortalTopbar({ brandName }: { brandName: string }) {
  return (
    <header className="portal-topbar" role="banner">
      <a className="portal-brand" href="/" aria-label={`${brandName} — your portal`}>
        <BrandShield size={26} />
        <span>{brandName}</span>
      </a>
      <IdentityChip />
    </header>
  );
}
