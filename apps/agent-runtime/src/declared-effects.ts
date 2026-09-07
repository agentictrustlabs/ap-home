// WHAT FOLLOWS THE ACT — spec 360 E5, the executor side.
//
// The incident: USDC moved from Alice to Bob and neither of them was told, while the Treasury playbook
// already promised "every payment leaves a receipt". The promise is now declared in the SKILL.md
// (`effects:`), compiled into the definition (`declaredEffects`), and discharged here.
//
// AN EFFECT IS NOT A STEP (spec 360 §1). Nothing here is planned, nothing is chosen by a model, and the
// content is derived from what the invoker actually returned — never composed. That is why it rides the
// payment's own mandate instead of asking for a second signature: the recipient is the payee NAMED IN
// THAT MANDATE, and telling them the payment happened discloses a fact they are already party to.
//
// IT MAY NOT FAIL THE STEP. The money moved, on chain. The loop isolates a throw here into an
// `EffectFailed` event and the step stays `executed` — a receipt that could un-do a payment would be
// worse than no receipt.
import type { Address } from 'viem';
import type { EffectSink } from '@agenticprimitives/orchestration';
import type { DeclaredEffectV1 } from '@agenticprimitives/capability-claims';

/** The `apix:PaymentReceipt` a vault holds — field names ARE the T-box property names, so the record is
 *  readable BY the ontology rather than interpreted into it (`packages/ontology/src/vault-records.ts`). */
export interface PaymentReceiptRecordV1 {
  type: 'ap.payment-receipt.v1';
  payer: string;
  payee: string;
  asset: string;
  amount: string;
  txHash: string;
  /** What authorised it, for a reader who wants to check rather than believe. */
  runRef: string;
  mandateRef: string | null;
  settledAt: string;
}

export interface EffectDeps {
  /** Write ONE record into a principal's own vault (the internal, allowlisted op). */
  writeSubjectRecord?: (subject: string, recordType: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
  /** Deliver a direct message — the thread projection of a record. */
  sendDirectMessage?: (input: {
    sender: Address; recipient: Address; bodyText: string; session: string;
    contextRefs?: Array<{ kind: string; id: string; label?: string }>;
  }) => Promise<{ ok: true; messageId?: string } | { ok: false; error: string }>;
  /** A name for an address, when one is known. Display only; absence is not an error. */
  nameFor?: (address: string) => Promise<string | null>;
  /** The owner an agent is chartered under (`ap:charteredUnder`, on chain). A payee treasury's receipt
   *  message is delivered to ITS OWNER — the same reasoning already applied to the payer side: a
   *  treasury's inbox is not a place anyone looks. Null = unchartered = tell the payee agent itself. */
  ownerOf?: (agent: string) => Promise<string | null>;
}

const lc = (v: unknown): string => String(v ?? '').toLowerCase();

/** Base units → a human amount, for the sentence only. USDC is 6dp; anything else stays in base units
 *  rather than being rendered with a decimal place nobody verified. */
function displayAmount(amount: string, asset: string, usdc?: string): string {
  if (usdc && lc(asset) === lc(usdc)) {
    const n = Number(amount);
    if (Number.isFinite(n)) return `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDC`;
  }
  return `${amount} (base units)`;
}

/**
 * The sentence a person reads, RENDERED FROM THE RECORD's own fields.
 *
 * Never model-composed (spec 358 W3's grounded-composition rule applied to a notification): every number
 * here came back from the chain call, and a notification that paraphrased it would be a claim about
 * someone's money.
 */
export function receiptSentence(
  r: PaymentReceiptRecordV1,
  opts: { payerName?: string | null; payeeName?: string | null; usdc?: string; payeeOwnerName?: string | null },
): string {
  const who = opts.payerName ? opts.payerName : `${r.payer.slice(0, 6)}…${r.payer.slice(-4)}`;
  const shortPayee = `${r.payee.slice(0, 6)}…${r.payee.slice(-4)}`;
  // An UNNAMED treasury has no name to give, and printing a bare address to the person who owns it is
  // the least useful true thing available. Whose it is, we usually know — that is how the payment was
  // routed there at all — so say that, with the address after it for anyone who wants to check.
  const to = opts.payeeName ? `${opts.payeeName} (${shortPayee})`
    : opts.payeeOwnerName ? `${opts.payeeOwnerName}'s treasury (${shortPayee})`
    : shortPayee;
  const amount = displayAmount(r.amount, r.asset, opts.usdc);
  // ONE SENTENCE, TWO READERS. A direct message is one body in a two-party thread: the payee's copy and
  // the payer's copy are the same bytes, so a sentence written in the second person ("sent you") reads
  // as a mistake in whichever thread it was not written for. Naming both parties is correct from either
  // side, which is what lets a single message satisfy "both of them get told".
  return [
    `${who} sent ${amount} to ${to}.`,
    `Transaction ${r.txHash}.`,
    `This is a receipt of a transfer that settled — it says the money moved, not what it was for.`,
  ].join(' ');
}

/** The payment invoker's return shape (`harness-run.ts`), which is what the receipt is built from. */
interface PaymentResult { txHash?: string; asset?: string; payee?: string; amount?: string; payer?: string; alreadySettled?: boolean }

/**
 * The sink the loop calls after a step succeeds. Bound by the app because only the app knows what a
 * PaymentReceipt is, where a vault lives and how a message is delivered; `packages/orchestration` stays
 * domain-free and only knows THAT an effect was declared and WHEN to discharge it.
 */
export function declaredEffectSink(
  deps: EffectDeps,
  /** `person` is the human who asked. The PAYER side of a transfer is an org or a treasury — an agent
   *  with an inbox nobody opens — so its confirmation is delivered to the person who authorised it,
   *  which is who actually wants to know. The payer's own copy of the RECORD still lands in its vault. */
  ctx: { session?: string; usdc?: string; person?: string },
): EffectSink {
  return {
    discharge: async (e) => {
      const effect = e.effect as DeclaredEffectV1;
      if (effect?.produces !== 'PaymentReceipt') return; // the only artifact this app can build today
      const result = e.result as PaymentResult | null;
      // A payment that was ALREADY settled produces no new receipt: the settling run wrote one, and
      // inventing a second with no txHash would be a claim (the same rule the invoker follows).
      if (!result?.txHash || result.alreadySettled) return;

      // THE RECIPIENT IS PINNED TO THE STEP'S OWN ARG (spec 360 §1) — read from the resolved args the
      // verifier judged, never from anything a model wrote into prose.
      const payee = lc(e.step.args?.[effect.recipientArg] ?? result.payee);
      const payer = lc(result.payer);
      if (!/^0x[0-9a-f]{40}$/.test(payee) || !/^0x[0-9a-f]{40}$/.test(payer)) return;

      const record: PaymentReceiptRecordV1 = {
        type: 'ap.payment-receipt.v1',
        payer, payee,
        asset: lc(result.asset),
        amount: String(result.amount ?? ''),
        txHash: String(result.txHash),
        runRef: e.runRef,
        mandateRef: e.receipt.authority?.presentedRef ?? null,
        settledAt: new Date().toISOString(),
      };
      const resource = `payment.receipt:${record.txHash.toLowerCase()}`;

      // BOTH PARTIES HOLD IT. Each copy is written by that principal's OWN grant, inside their own DO —
      // the payer has no authority over the payee's vault and must not need any.
      const parties = new Set<string>();
      for (const role of effect.deliverTo) {
        if (role === 'payer') parties.add(payer);
        if (role === 'payee') parties.add(payee);
      }
      const failures: string[] = [];
      if (effect.surface.includes('record') && deps.writeSubjectRecord) {
        for (const subject of parties) {
          const out = await deps.writeSubjectRecord(subject, resource, record).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          if (!out.ok) failures.push(`${subject}: ${out.error ?? 'write failed'}`);
        }
      }

      // THE THREAD is a projection of the record, not a second source of truth. It is where a person
      // actually looks, which is the whole reason the incident was invisible.
      // THE SENDER IS THE PERSON WHOSE SIGNATURE MOVED THE MONEY. The first cut sent as the PAYER
      // agent — but a treasury or an org has no session of its own, and its outbound rail rightly
      // demands a stewardship presentation (SEC-C1) the payment run does not and must not carry: a
      // payment mandate becoming a speak-as-the-org grant would be authority widened by a side effect.
      // So every notification rides the acting person's OWN rail (their session, their DO, isSelf) —
      // one mechanism chosen by a fact, never a fallback (ADR-0013) — and the SENTENCE still names the
      // payer from the record, so nothing is misattributed: "Missio Nexus sent you 100 USDC" from the
      // steward who executed it is exactly what happened.
      const sender = String(ctx.person ?? '').toLowerCase();
      if (effect.surface.includes('thread') && deps.sendDirectMessage && ctx.session && /^0x[0-9a-f]{40}$/.test(sender)) {
        const [payerName, payeeName] = await Promise.all([
          deps.nameFor?.(payer).catch(() => null) ?? Promise.resolve(null),
          deps.nameFor?.(payee).catch(() => null) ?? Promise.resolve(null),
        ]);
        const words = (payeeOwnerName: string | null) =>
          receiptSentence(record, { payerName, payeeName, payeeOwnerName, ...(ctx.usdc ? { usdc: ctx.usdc } : {}) });
        const notify = async (to: string, payeeOwnerName: string | null) => {
          // Never message yourself: a note from you to you is not a notification. The payer SIDE lands
          // here by construction — the person who authorised the payment is the sender, and their
          // confirmation is the receipt record in the payer's vault plus the run's own done reply.
          if (!/^0x[0-9a-f]{40}$/.test(to) || to === sender) return;
          const sent = await deps.sendDirectMessage!({
            sender: sender as Address, recipient: to as Address, bodyText: words(payeeOwnerName), session: ctx.session!,
          }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
          if (!sent.ok) failures.push(`notify ${to}: ${sent.error}`);
        };
        if (parties.has(payee)) {
          // THE PAYEE'S PERSON, not the payee's inbox. The payee named in the mandate is a treasury; the
          // ap:charteredUnder edge (public, both-parties-signed) says whose it is, and the fact disclosed
          // — that their own treasury was paid — is theirs by construction. An unchartered payee keeps
          // the old behaviour: the message goes to the agent itself.
          const payeeOwner = deps.ownerOf ? await deps.ownerOf(payee).catch(() => null) : null;
          const ownerName = payeeOwner && payeeOwner !== payee ? await deps.nameFor?.(payeeOwner).catch(() => null) ?? null : null;
          // ONE MESSAGE REACHES BOTH. A direct message keeps a copy in each side's own thread, so telling
          // the payee's person also puts the receipt in the payer's conversation with them — which is why
          // there is no second send here and why "both parties get told" is one act, not two.
          await notify(payeeOwner ?? payee, ownerName);
        }
      }

      // Throwing here reaches the loop's isolation and becomes an `EffectFailed` event: the payment
      // stands, and the failure to disclose is recorded as its own fact rather than dressed as success.
      if (failures.length) throw new Error(`payment receipt not fully delivered — ${failures.join('; ')}`);
    },
  };
}
