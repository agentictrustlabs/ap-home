// Spec 410 §10.2 item 3 — the dispute path: a disputant opens an interaction citing a receipt, the counterparty
// answers, a steward the REGISTRY names records a determination; every exchange is signed by its author and verified
// against them; nothing is reversed. This is the package half of `check:meaning-and-stewardship`'s dispute leg.
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { openDispute, appendDisputeExchange, disputeExchangeDigest, disputeIdOf, runDisputePointer, type DisputeExchangeBodyV1, type DisputeExchangeV1 } from '../../src/dispute.js';

const ALICE = '0x0a60000000000000000000000000000000000001' as Address;
const MISSIO = '0x0a60000000000000000000000000000000000002' as Address;
const STEWARD = '0x0a60000000000000000000000000000000000009' as Address;
const STRANGER = '0x0a60000000000000000000000000000000000004' as Address;
const receipt = { agent: MISSIO, runRef: 'run-42', stepRef: 's1', receiptDigest: `0x${'ab'.repeat(32)}`, capability: 'organization.membership.add' };
const ID = disputeIdOf(receipt, ALICE);
/** Each party's "signature": the digest signed by them, checkable by our verifier; a stranger's signature never verifies. */
const sign = (author: Address, body: DisputeExchangeBodyV1): DisputeExchangeV1 => { const digest = disputeExchangeDigest(body); return { ...body, digest, signature: `0xsig:${author.toLowerCase()}:${digest}` as Hex }; };
const verifySig = async (signer: Address, digest: Hex, sig: Hex) => sig === `0xsig:${signer.toLowerCase()}:${digest}`;
const stewardOf = async (subject: string) => (subject === 'https://agenticprimitives.dev/ns/org#' ? STEWARD : null);
const now = () => new Date('2026-09-20T12:00:00Z');
const x = (author: Address, role: DisputeExchangeBodyV1['role'], performative: DisputeExchangeBodyV1['performative'], seq: number, previous: Hex | null, words: string, under?: string): DisputeExchangeV1 =>
  sign(author, { type: 'ap.dispute-exchange.v1', interactionId: ID, seq, previous, author, role, performative, words, at: now().toISOString(), ...(under ? { under } : {}) });

describe('the dispute path', () => {
  it('opens with the disputant\'s signed REQUEST citing the receipt; the id is derived, so disputing twice finds the same interaction', async () => {
    const opened = await openDispute({ receipt, disputant: ALICE, counterparty: MISSIO, opening: x(ALICE, 'disputant', 'REQUEST', 0, null, 'the roster shows Sarah added twice'), now }, verifySig);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.interaction).toMatchObject({ id: ID, profileVersion: 'dispute/1.0.0', parties: { disputant: ALICE, counterparty: MISSIO }, receipt });
    expect(disputeIdOf(receipt, ALICE)).toBe(ID);
    expect(runDisputePointer(opened.interaction)).toMatchObject({ type: 'ap.run-dispute.v1', runRef: 'run-42', disputedBy: ID });
    // A stranger cannot open as the disputant; a wrong performative cannot open at all.
    expect((await openDispute({ receipt, disputant: ALICE, counterparty: MISSIO, opening: x(STRANGER, 'disputant', 'REQUEST', 0, null, 'hi'), now }, verifySig)).ok).toBe(false);
    expect((await openDispute({ receipt, disputant: ALICE, counterparty: MISSIO, opening: x(ALICE, 'disputant', 'INFORM', 0, null, 'hi'), now }, verifySig)).ok).toBe(false);
  });
  it('the counterparty answers, the steward the registry names determines, and the interaction closes — a stranger, a wrong subject or a forged signature is refused by name', async () => {
    const opened = await openDispute({ receipt, disputant: ALICE, counterparty: MISSIO, opening: x(ALICE, 'disputant', 'REQUEST', 0, null, 'the roster shows Sarah added twice'), now }, verifySig);
    if (!opened.ok) throw new Error(opened.reason);
    const d0 = opened.interaction.exchanges[0]!.digest;
    // Out of order, or a stranger as counterparty: refused.
    expect((await appendDisputeExchange(opened.interaction, x(MISSIO, 'counterparty', 'INFORM', 2, d0, 'no'), { verifySig, stewardOf, now })).ok).toBe(false);
    expect(JSON.stringify(await appendDisputeExchange(opened.interaction, x(STRANGER, 'counterparty', 'INFORM', 1, d0, 'no'), { verifySig, stewardOf, now }))).toMatch(/only the party the receipt names/);
    const answered = await appendDisputeExchange(opened.interaction, x(MISSIO, 'counterparty', 'INFORM', 1, d0, 'one add was reconciled, not repeated — see the receipt'), { verifySig, stewardOf, now });
    expect(answered.ok).toBe(true); if (!answered.ok) return;
    const d1 = answered.interaction.exchanges[1]!.digest;
    // A steward must name the subject the registry names them for; a subject with no steward, or another agent, is refused.
    expect(JSON.stringify(await appendDisputeExchange(answered.interaction, x(STEWARD, 'steward', 'ISSUE', 2, d1, 'determined'), { verifySig, stewardOf, now }))).toMatch(/names the subject/);
    expect(JSON.stringify(await appendDisputeExchange(answered.interaction, x(STEWARD, 'steward', 'ISSUE', 2, d1, 'determined', 'https://agenticprimitives.dev/ns/core#'), { verifySig, stewardOf, now }))).toMatch(/names no steward/);
    expect(JSON.stringify(await appendDisputeExchange(answered.interaction, x(STRANGER, 'steward', 'ISSUE', 2, d1, 'determined', 'https://agenticprimitives.dev/ns/org#'), { verifySig, stewardOf, now }))).toMatch(/is not the steward the registry names/);
    // A forged signature (the steward's words, a stranger's key) is refused before the role is even considered.
    const forged = { ...x(STEWARD, 'steward', 'ISSUE', 2, d1, 'determined', 'https://agenticprimitives.dev/ns/org#'), signature: `0xsig:${STRANGER}:${d1}` as Hex };
    expect(JSON.stringify(await appendDisputeExchange(answered.interaction, forged, { verifySig, stewardOf, now }))).toMatch(/signature did not verify/);
    const determined = await appendDisputeExchange(answered.interaction, x(STEWARD, 'steward', 'ISSUE', 2, d1, 'the second add was the reconcile of a lost response; one membership stands; no reversal', 'https://agenticprimitives.dev/ns/org#'), { verifySig, stewardOf, now });
    expect(determined.ok).toBe(true); if (!determined.ok) return;
    expect(determined.interaction.closed).toEqual({ reason: 'determined', at: now().toISOString(), by: STEWARD });
    expect(determined.interaction.parties.steward).toBe(STEWARD);
    expect(runDisputePointer(determined.interaction).closed?.reason).toBe('determined');
    // Closed is closed: nothing more is appended.
    expect(JSON.stringify(await appendDisputeExchange(determined.interaction, x(ALICE, 'disputant', 'INFORM', 3, determined.interaction.exchanges[2]!.digest, 'but'), { verifySig, stewardOf, now }))).toMatch(/closed/);
  });
});
