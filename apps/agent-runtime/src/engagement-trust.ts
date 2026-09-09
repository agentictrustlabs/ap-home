// THE TRUST-GRAPH READ — spec 384 W4 (336 §3.6 / spec 358 W3). Beside a firm offer, what the public trust
// fabric says about the two parties: is there a relationship edge between the requester and this provider,
// how many VALID attestations does the provider hold, and are there prior receipts between them. Read from
// the world-readable KB (ADR-0040), the same tier discovery is (`/trust?key=`).
//
// EVIDENCE, NEVER A SCORE, NEVER A FILTER. Each fact is a LINE a person (and the selection's `because`) can
// read; nothing here is summed, weighted, or turned into a threshold. A stranger's offer reads "no prior
// receipts, no relationship" and is STILL an offer — the read informs the person, it does not gate the offer
// (336 §3.2: a scalar over candidates is the drift this forbids).
import type { Address } from 'viem';
import type { DiscoveryFetch } from '@agenticprimitives/context';

export interface TrustGraphReadV1 {
  type: 'ap.trust-graph-read.v1';
  requester: Address;
  provider: Address;
  /** The edge between the two, if the fabric holds one (any active/confirmed status). Never a score. */
  relationship: { relationshipType: string | null; status: string; direction: 'subject' | 'object' } | null;
  /** How many of the provider's attestations verify. A count of facts, not a rating. */
  validAttestations: number;
  /** Prior receipts BETWEEN these two parties, when the estate indexes them; `null` when it does not
   *  (faithnet does not), which reads as "none recorded" — the honest answer, not zero pretending to be one. */
  priorReceipts: number | null;
  /** The human-readable evidence, one fact per line. What the selection cites and a person reads. */
  lines: string[];
}

interface TrustRow { edgeId: string; relationshipType: string | null; counterparty: string; direction: 'subject' | 'object'; status: string }
interface AttRow { uid: string; valid: boolean }

/** Read the trust fabric between `requester` and `provider`. Best-effort: an unreachable fabric yields a read
 *  that says so, never a throw that fails an offer — a missing read is not a mark against a provider. */
export async function trustGraphRead(fetchDiscovery: DiscoveryFetch, requester: Address, provider: Address): Promise<TrustGraphReadV1> {
  const base: TrustGraphReadV1 = { type: 'ap.trust-graph-read.v1', requester, provider, relationship: null, validAttestations: 0, priorReceipts: null, lines: [] };
  let rels: TrustRow[] = []; let atts: AttRow[] = []; let read = true;
  try {
    const res = await fetchDiscovery(`/trust?key=${encodeURIComponent(provider)}`);
    if (!res || !res.ok) read = false;
    else { const b = (await res.json().catch(() => null)) as { relationships?: TrustRow[]; attestations?: AttRow[] } | null; rels = b?.relationships ?? []; atts = b?.attestations ?? []; }
  } catch { read = false; }
  if (!read) return { ...base, lines: ['the public trust fabric could not be read for this provider'] };
  const req = requester.toLowerCase();
  const edge = rels.find((r) => r.counterparty.toLowerCase() === req && /^(active|confirmed)$/i.test(r.status));
  const validAttestations = atts.filter((a) => a.valid).length;
  const lines: string[] = [];
  lines.push(edge ? `holds a ${edge.relationshipType ?? 'relationship'} with the requester (${edge.status})` : 'no relationship with the requester on the public fabric');
  lines.push(validAttestations ? `${validAttestations} valid attestation${validAttestations === 1 ? '' : 's'}` : 'no valid attestations');
  lines.push('no prior receipts recorded between these two parties'); // faithnet indexes none; the honest line
  return { ...base, relationship: edge ? { relationshipType: edge.relationshipType, status: edge.status, direction: edge.direction } : null, validAttestations, priorReceipts: null, lines };
}
