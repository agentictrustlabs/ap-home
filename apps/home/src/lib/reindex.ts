// Auto-index trigger: when the home creates/names/registers an agent, ask the discovery indexer to project
// it into the knowledge base immediately, so it shows up in the Registry / discovery within seconds instead
// of waiting for the next batch index run. Fire-and-forget + best-effort — never blocks or throws into the
// caller, and the periodic full index is the backstop. (ADR-0040: the indexer only writes public, on-chain-
// derivable facts, and only for SAs that actually resolve to a name, so this trigger can't pollute the KB.)
import type { Address } from '@agenticprimitives/types';

const INDEX_URL = (process.env.NEXT_PUBLIC_DISCOVERY_INDEX_URL as string | undefined) ?? 'https://demo-discovery-indexer.richardpedersen3.workers.dev';

export function requestReindex(agents: (Address | null | undefined)[]): void {
  const list = [...new Set(agents.filter((a): a is Address => !!a).map((a) => a.toLowerCase()))];
  if (!list.length) return;
  try {
    // keepalive so it still flies if the page navigates right after onboarding completes.
    void fetch(`${INDEX_URL}/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agents: list }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* best-effort; the periodic full index is the backstop */ }
}
