'use client';
// "explorer ↗" — but only when this chain HAS one.
//
// Three components each hardcoded `https://sepolia.basescan.org/address/`, so on any other chain every
// explorer link sent a person to a scanner that has never heard of the address they clicked. Deriving it
// per chain fixes that but creates a second case: a chain with no explorer configured. An empty base
// would render `href="0x…"`, a relative link that navigates inside the app — worse than a wrong scanner,
// because it looks like the app is broken rather than the link.
//
// So the decision lives in one place: no explorer, no link.
import { EXPLORER } from '../../lib/chain';

export function ExplorerLink({ address, label = 'explorer ↗', style }: {
  address: string | null | undefined;
  label?: string;
  style?: React.CSSProperties;
}) {
  if (!EXPLORER || !address) return null;
  return (
    <a href={`${EXPLORER}${address}`} target="_blank" rel="noreferrer" style={style}>{label}</a>
  );
}
