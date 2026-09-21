// THE DISPUTE PATH — spec 410 §10.2 item 3 (THESIS-10). A disagreement about a receipt is an INTERACTION under the
// `dispute/1.0.0` profile (`@agenticprimitives/fabric`): the disputant opens it citing the receipt (a REQUEST), the
// counterparty answers (INFORM / REJECT / ACKNOWLEDGE), and a steward named in the public record (the term registry's
// steward row, spec 410 §10.2 item 4) records a DETERMINATION (an ISSUE) that closes it. Every exchange is one
// immutable signed unit — signed by its author's own credential, verified against the author's Smart Agent — and
// the interaction is held as one record in BOTH parties' vaults (`interaction.dispute:<id>`, spec 410 §8's rule for
// shared records), with a pointer from the run (`run.dispute:<runRef>` → `apexec:disputedBy`).
//
// IT GRANTS NOTHING AND REVERSES NOTHING. A determination is evidence the provenance links; a reversal is a new act
// under a new mandate. Nothing here reads a chain edge for standing: the disputant is whoever holds the receipt, the
// counterparty is whom the receipt names, and the steward is whom the registry names — three public facts.
import { keccak256, stringToBytes, type Address, type Hex } from 'viem';
import { jcsCanonicalize } from '@agenticprimitives/types';
import { DISPUTE_PROFILE } from '@agenticprimitives/fabric';

export const DISPUTE_RECORD_PREFIX = 'interaction.dispute:' as const;
export const RUN_DISPUTE_PREFIX = 'run.dispute:' as const;
export const disputeRecordType = (id: string): string => `${DISPUTE_RECORD_PREFIX}${id}`;
export const runDisputeRecordType = (runRef: string): string => `${RUN_DISPUTE_PREFIX}${runRef}`;

export type DisputePerformative = 'REQUEST' | 'INFORM' | 'QUERY' | 'ACKNOWLEDGE' | 'ISSUE' | 'REJECT';
export type DisputeRole = 'disputant' | 'counterparty' | 'steward';

/** What one party signs: the exchange without its signature. */
export interface DisputeExchangeBodyV1 {
  type: 'ap.dispute-exchange.v1';
  interactionId: string;
  /** Position in the interaction: the opening REQUEST is 0; each exchange names the digest of the one before it. */
  seq: number;
  previous: Hex | null;
  author: Address;
  role: DisputeRole;
  performative: DisputePerformative;
  words: string;
  at: string;
  /** For a determination: the steward record it acts under (the subject IRI whose steward the registry names). */
  under?: string;
}
export interface DisputeExchangeV1 extends DisputeExchangeBodyV1 { digest: Hex; signature: Hex }

export interface DisputeInteractionV1 {
  type: 'ap.dispute-interaction.v1';
  id: string;
  profileVersion: typeof DISPUTE_PROFILE.profileVersion;
  /** The receipt disputed — the one required context (`requiredContextKinds: ['receipt']`). */
  receipt: { agent: Address; runRef: string; stepRef?: string; receiptDigest?: string; capability?: string };
  parties: { disputant: Address; counterparty: Address; steward?: Address };
  exchanges: DisputeExchangeV1[];
  openedAt: string;
  closed?: { reason: 'determined' | 'withdrawn' | 'declined-by-steward' | 'expired'; at: string; by: Address };
}

const digestOf = (v: unknown): Hex => keccak256(stringToBytes(jcsCanonicalize(v)));
/** The digest a party signs — RFC 8785 over the body; the signature is not in it. */
export const disputeExchangeDigest = (b: DisputeExchangeBodyV1): Hex => digestOf({ ...b, author: b.author.toLowerCase() });
/** The interaction id, DERIVED from the receipt and the disputant: disputing the same receipt twice finds the same interaction. */
export const disputeIdOf = (receipt: DisputeInteractionV1['receipt'], disputant: Address): string => `dsp_${digestOf({ agent: receipt.agent.toLowerCase(), runRef: receipt.runRef, ...(receipt.stepRef ? { stepRef: receipt.stepRef } : {}), disputant: disputant.toLowerCase() }).slice(2, 34)}`;

export type SignatureCheck = (signer: Address, digest: Hex, signature: Hex) => Promise<boolean>;

/** Which performatives each role may sign under the profile; the profile's list is the outer bound. */
const ALLOWED: Record<DisputeRole, readonly DisputePerformative[]> = {
  disputant: ['REQUEST', 'INFORM', 'QUERY', 'ACKNOWLEDGE'],
  counterparty: ['INFORM', 'QUERY', 'ACKNOWLEDGE', 'REJECT'],
  steward: ['ISSUE', 'QUERY', 'REJECT'],
};

/** Verify one exchange: its digest, its signature against its author, its role's right to this performative, its place. */
export async function verifyDisputeExchange(x: DisputeExchangeV1, expect: { interactionId: string; seq: number; previous: Hex | null }, verifySig: SignatureCheck): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (x.type !== 'ap.dispute-exchange.v1') return { ok: false, reason: 'not a dispute exchange' };
  if (x.interactionId !== expect.interactionId) return { ok: false, reason: 'the exchange names another interaction' };
  if (x.seq !== expect.seq || (x.previous ?? null) !== (expect.previous ?? null)) return { ok: false, reason: `the exchange is out of order (seq ${x.seq}, expected ${expect.seq})` };
  if (!DISPUTE_PROFILE.permittedActs.includes(x.performative)) return { ok: false, reason: `${x.performative} is not permitted under ${DISPUTE_PROFILE.profileVersion}` };
  if (!ALLOWED[x.role]?.includes(x.performative)) return { ok: false, reason: `a ${x.role} may not ${x.performative} in a dispute` };
  if (!x.words.trim() || x.words.length > 4000) return { ok: false, reason: 'the words are missing or too long' };
  const { digest, signature, ...body } = x;
  if (disputeExchangeDigest(body).toLowerCase() !== digest.toLowerCase()) return { ok: false, reason: 'the exchange digest does not match its body' };
  if (!(await verifySig(x.author, digest, signature).catch(() => false))) return { ok: false, reason: `${x.role}'s signature did not verify against ${x.author}` };
  return { ok: true };
}

/** Open: the disputant's REQUEST is exchange 0; the interaction is derived from the receipt and the disputant. */
export async function openDispute(input: { receipt: DisputeInteractionV1['receipt']; disputant: Address; counterparty: Address; opening: DisputeExchangeV1; now: () => Date }, verifySig: SignatureCheck): Promise<{ ok: true; interaction: DisputeInteractionV1 } | { ok: false; reason: string }> {
  const id = disputeIdOf(input.receipt, input.disputant);
  if (input.opening.author.toLowerCase() !== input.disputant.toLowerCase() || input.opening.role !== 'disputant' || input.opening.performative !== 'REQUEST') return { ok: false, reason: 'a dispute opens with the disputant\'s REQUEST' };
  const v = await verifyDisputeExchange(input.opening, { interactionId: id, seq: 0, previous: null }, verifySig);
  if (!v.ok) return v;
  return { ok: true, interaction: { type: 'ap.dispute-interaction.v1', id, profileVersion: DISPUTE_PROFILE.profileVersion, receipt: { ...input.receipt, agent: input.receipt.agent.toLowerCase() as Address }, parties: { disputant: input.disputant.toLowerCase() as Address, counterparty: input.counterparty.toLowerCase() as Address }, exchanges: [input.opening], openedAt: input.now().toISOString() } };
}

/**
 * Append: the counterparty's answer, or the steward's determination. The author must be a party — the counterparty
 * as the receipt names it, or the steward the REGISTRY names for the subject the exchange claims to act under
 * (`stewardOf`, a public read; absent ⇒ refused by name). An ISSUE closes the interaction as `determined`; a
 * steward's REJECT closes it `declined-by-steward`.
 */
export async function appendDisputeExchange(interaction: DisputeInteractionV1, x: DisputeExchangeV1, deps: { verifySig: SignatureCheck; stewardOf: (subject: string) => Promise<Address | null>; now: () => Date }): Promise<{ ok: true; interaction: DisputeInteractionV1 } | { ok: false; reason: string }> {
  if (interaction.closed) return { ok: false, reason: `this dispute is closed (${interaction.closed.reason})` };
  const last = interaction.exchanges[interaction.exchanges.length - 1]!;
  const author = x.author.toLowerCase();
  if (x.role === 'disputant' && author !== interaction.parties.disputant) return { ok: false, reason: 'only the disputant speaks as the disputant' };
  if (x.role === 'counterparty' && author !== interaction.parties.counterparty) return { ok: false, reason: 'only the party the receipt names answers as the counterparty' };
  if (x.role === 'steward') {
    if (!x.under) return { ok: false, reason: 'a steward names the subject whose steward record they act under' };
    const named = await deps.stewardOf(x.under).catch(() => null);
    if (!named) return { ok: false, reason: `the registry names no steward for ${x.under}` };
    if (named.toLowerCase() !== author) return { ok: false, reason: `${x.author} is not the steward the registry names for ${x.under} (${named})` };
  }
  const v = await verifyDisputeExchange(x, { interactionId: interaction.id, seq: interaction.exchanges.length, previous: last.digest }, deps.verifySig);
  if (!v.ok) return v;
  const next: DisputeInteractionV1 = { ...interaction, exchanges: [...interaction.exchanges, x], ...(x.role === 'steward' ? { parties: { ...interaction.parties, steward: author as Address } } : {}) };
  if (x.role === 'steward' && x.performative === 'ISSUE') next.closed = { reason: 'determined', at: deps.now().toISOString(), by: author as Address };
  if (x.role === 'steward' && x.performative === 'REJECT') next.closed = { reason: 'declined-by-steward', at: deps.now().toISOString(), by: author as Address };
  return { ok: true, interaction: next };
}

/** The pointer the run keeps: which dispute cites it (`apexec:disputedBy`). */
export const runDisputePointer = (interaction: DisputeInteractionV1): { type: 'ap.run-dispute.v1'; runRef: string; disputedBy: string; openedAt: string; closed?: DisputeInteractionV1['closed'] } => ({ type: 'ap.run-dispute.v1', runRef: interaction.receipt.runRef, disputedBy: interaction.id, openedAt: interaction.openedAt, ...(interaction.closed ? { closed: interaction.closed } : {}) });
