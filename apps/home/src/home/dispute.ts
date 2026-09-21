// THE DISPUTE PATH, FROM THE HOME — spec 410 §10.2 item 3. A receipt the person disagrees with is disputed by opening
// an interaction under `dispute/1.0.0` at her agent: she signs the opening REQUEST with her own credential; the
// counterparty answers with theirs; a steward named in the public record determines. The agent verifies every
// signature on chain and holds the interaction in both parties' vaults. Nothing here grants or reverses.
//
// The exchange digest is RFC 8785 over the body, keccak256 — the SAME function the agent recomputes (`dispute.ts`
// there); a client that computed it differently would be refused, never trusted.
import { keccak256, stringToBytes, type Address, type Hex } from 'viem';
import { jcsCanonicalize } from '@agenticprimitives/types';
import { ensureCsrfToken, csrfHeaders } from '../csrf';
import type { SignHash } from './resolution';
import { readPersonRecord } from '../profile-store';

export type DisputePerformative = 'REQUEST' | 'INFORM' | 'QUERY' | 'ACKNOWLEDGE' | 'ISSUE' | 'REJECT';
export type DisputeRole = 'disputant' | 'counterparty' | 'steward';
export interface DisputeExchangeBodyV1 { type: 'ap.dispute-exchange.v1'; interactionId: string; seq: number; previous: Hex | null; author: Address; role: DisputeRole; performative: DisputePerformative; words: string; at: string; under?: string }
export interface DisputeExchangeV1 extends DisputeExchangeBodyV1 { digest: Hex; signature: Hex }
export interface DisputeInteractionV1 {
  type: 'ap.dispute-interaction.v1'; id: string; profileVersion: string;
  receipt: { agent: Address; runRef: string; stepRef?: string; receiptDigest?: string; capability?: string };
  parties: { disputant: Address; counterparty: Address; steward?: Address };
  exchanges: DisputeExchangeV1[]; openedAt: string;
  closed?: { reason: string; at: string; by: Address };
}
export interface RunDisputePointerV1 { type: 'ap.run-dispute.v1'; runRef: string; disputedBy: string; openedAt: string; closed?: DisputeInteractionV1['closed'] }

const digestOf = (v: unknown): Hex => keccak256(stringToBytes(jcsCanonicalize(v)));
export const disputeExchangeDigest = (b: DisputeExchangeBodyV1): Hex => digestOf({ ...b, author: b.author.toLowerCase() });
export const disputeIdOf = (receipt: DisputeInteractionV1['receipt'], disputant: Address): string => `dsp_${digestOf({ agent: receipt.agent.toLowerCase(), runRef: receipt.runRef, ...(receipt.stepRef ? { stepRef: receipt.stepRef } : {}), disputant: disputant.toLowerCase() }).slice(2, 34)}`;

async function signed(author: Address, body: DisputeExchangeBodyV1, sign: SignHash): Promise<DisputeExchangeV1> {
  const digest = disputeExchangeDigest(body);
  return { ...body, digest, signature: await sign(digest) };
}
const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
  await ensureCsrfToken();
  const r = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(body) });
  return (await r.json().catch(() => ({}))) as Record<string, unknown>;
};

/** Open a dispute over a receipt: the person's signed REQUEST, at her agent. */
export async function openDisputeFromHome(input: { session: { token: string }; me: Address; receipt: DisputeInteractionV1['receipt']; counterparty: Address; words: string; sign: SignHash }): Promise<{ ok: true; interaction: DisputeInteractionV1; told?: { ok: boolean; error?: string } } | { ok: false; error: string }> {
  const id = disputeIdOf(input.receipt, input.me);
  const opening = await signed(input.me, { type: 'ap.dispute-exchange.v1', interactionId: id, seq: 0, previous: null, author: input.me, role: 'disputant', performative: 'REQUEST', words: input.words.trim(), at: new Date().toISOString() }, input.sign);
  const out = await post('/a2a/harness/dispute', { session: input.session.token, receipt: input.receipt, counterparty: input.counterparty, opening }) as { ok?: boolean; interaction?: DisputeInteractionV1; told?: { ok: boolean; error?: string }; error?: string };
  return out.ok && out.interaction ? { ok: true, interaction: out.interaction, ...(out.told ? { told: out.told } : {}) } : { ok: false, error: out.error ?? 'the dispute could not be opened' };
}

/** Append an exchange — the counterparty's answer, the disputant's follow-up, or the steward's determination (`under` names the subject the registry names them for). */
export async function appendDisputeFromHome(input: { session: { token: string }; me: Address; interaction: DisputeInteractionV1; role: DisputeRole; performative: DisputePerformative; words: string; under?: string; sign: SignHash }): Promise<{ ok: true; interaction: DisputeInteractionV1 } | { ok: false; error: string }> {
  const last = input.interaction.exchanges[input.interaction.exchanges.length - 1];
  const exchange = await signed(input.me, { type: 'ap.dispute-exchange.v1', interactionId: input.interaction.id, seq: input.interaction.exchanges.length, previous: last?.digest ?? null, author: input.me, role: input.role, performative: input.performative, words: input.words.trim(), at: new Date().toISOString(), ...(input.under ? { under: input.under } : {}) }, input.sign);
  const holder = input.role === 'counterparty' ? input.interaction.parties.counterparty : input.interaction.parties.disputant;
  const out = await post('/a2a/harness/dispute/exchange', { session: input.session.token, interactionId: input.interaction.id, holder, exchange }) as { ok?: boolean; interaction?: DisputeInteractionV1; error?: string };
  return out.ok && out.interaction ? { ok: true, interaction: out.interaction } : { ok: false, error: out.error ?? 'the exchange was not accepted' };
}

/** The dispute a run of MINE points at (my vault's `run.dispute:<runRef>` → `interaction.dispute:<id>`), or null. */
export async function readDisputeFor(me: Address, runRef: string): Promise<DisputeInteractionV1 | null> {
  const pointer = (await readPersonRecord(me, `run.dispute:${runRef}`).catch(() => null)) as RunDisputePointerV1 | null;
  if (!pointer?.disputedBy) return null;
  return (await readPersonRecord(me, `interaction.dispute:${pointer.disputedBy}`).catch(() => null)) as DisputeInteractionV1 | null;
}
