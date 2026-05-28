// Display a Smart Agent (person/org) — name, address, status, optional action. Presentational.
import { AddressChip } from '../shared/AddressChip';
import { ExternalLinkIcon } from '../shared/Icons';

export function AgentIdentityCard({
  name,
  address,
  label,
  status = 'live',
  explorerUrl,
  size = 'standard',
  primaryAction,
}: {
  name: string;
  address?: string;
  label?: string;
  status?: 'live' | 'soon';
  explorerUrl?: string;
  size?: 'hero' | 'standard' | 'compact';
  primaryAction?: { label: string; href: string };
}) {
  return (
    <div className={`agent-identity-card ${size} ${status}`}>
      <div className="agent-identity-name">{name}</div>
      {address && <AddressChip address={address} />}
      {label && <div className="agent-identity-sub">{label}</div>}
      {explorerUrl && (
        <a className="agent-identity-explorer" href={explorerUrl} target="_blank" rel="noreferrer">
          View on Base Sepolia <ExternalLinkIcon size={13} />
        </a>
      )}
      {primaryAction && <a className="btn-ghost" href={primaryAction.href}>{primaryAction.label}</a>}
    </div>
  );
}
