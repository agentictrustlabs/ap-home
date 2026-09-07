// Spec 360 E5 — the receipt both parties hold, and the sentence rendered from it.
import { describe, it, expect, vi } from 'vitest';
import { declaredEffectSink, receiptSentence, type PaymentReceiptRecordV1 } from '../src/declared-effects.js';

const USDC = '0x0000000000000000000000000000000000000abc';
const PAYER = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11';
const PAYEE = '0x8c5cddca27c088a65e58e94403acdc9bc3eb7fe3';
const EFFECT = { on: 'success', produces: 'PaymentReceipt', recipientArg: 'payee', deliverTo: ['payer', 'payee'], surface: ['record', 'thread'] };

const event = (over: Record<string, unknown> = {}) => ({
  runRef: 'run-1', stepRef: 's1', effect: EFFECT,
  step: { args: { payee: PAYEE, asset: USDC } },
  result: { txHash: '0xTX', asset: USDC, payee: PAYEE, amount: '3000000', payer: PAYER },
  receipt: { authority: { presentedRef: 'mandate-1' } },
  ...over,
}) as never;

describe('the payment receipt reaches BOTH parties', () => {
  it('the payee is told, FROM the acting person — an org payer has no rail of its own', async () => {
    // The payer here is an org/treasury SA; the ASKER is the steward whose signature moved the money.
    // The message rides the ASKER's own rail (their session drives their own DO), and the payer side
    // is not a message at all: the asker IS the sender, and their confirmation is the receipt record
    // plus the run's own done reply.
    const msgs: Array<{ sender: string; recipient: string; bodyText: string }> = [];
    const ASKER = '0x1111111111111111111111111111111111111111';
    const sink = declaredEffectSink({
      writeSubjectRecord: async () => ({ ok: true }),
      sendDirectMessage: async (m) => { msgs.push({ sender: m.sender, recipient: m.recipient, bodyText: m.bodyText }); return { ok: true }; },
    }, { session: 'tok', usdc: USDC, person: ASKER });
    await sink.discharge(event());
    expect(msgs.map((m) => m.recipient)).toEqual([PAYEE]);
    expect(msgs[0]!.sender).toBe(ASKER);
    // The SENTENCE still names the payer from the record — the sender is delivery, not attribution.
    // Side-NEUTRAL: one body lands in both threads, so it names both parties rather than saying "you".
    expect(msgs[0]!.bodyText).toMatch(/sent 3 USDC to /);
    expect(msgs[0]!.bodyText).toContain('0xTX');
  });

  it('never messages the payer agent as itself — a note from you to you is not a notification', async () => {
    const msgs: string[] = [];
    const sink = declaredEffectSink({
      writeSubjectRecord: async () => ({ ok: true }),
      sendDirectMessage: async (m) => { msgs.push(m.recipient); return { ok: true }; },
    }, { session: 'tok', usdc: USDC, person: PAYER });
    await sink.discharge(event());
    expect(msgs).toEqual([PAYEE]);
  });

  it('writes payment.receipt:<tx> to payer AND payee, and messages the payee', async () => {
    const writes: Array<[string, string, PaymentReceiptRecordV1]> = [];
    const msgs: Array<{ recipient: string; bodyText: string }> = [];
    const sink = declaredEffectSink({
      writeSubjectRecord: async (s, rt, r) => { writes.push([s, rt, r as PaymentReceiptRecordV1]); return { ok: true }; },
      sendDirectMessage: async (m) => { msgs.push({ recipient: m.recipient, bodyText: m.bodyText }); return { ok: true }; },
    }, { session: 'tok', usdc: USDC, person: PAYER });

    await sink.discharge(event());

    expect(writes.map((w) => w[0]).sort()).toEqual([PAYEE, PAYER].sort());
    expect(writes[0]![1]).toBe('payment.receipt:0xtx');
    expect(writes[0]![2]).toMatchObject({ type: 'ap.payment-receipt.v1', payer: PAYER, payee: PAYEE, amount: '3000000', txHash: '0xTX', mandateRef: 'mandate-1' });
    // The payee is TOLD; the payer already knows (they asked).
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.recipient).toBe(PAYEE);
    expect(msgs[0]!.bodyText).toContain('3 USDC');
    expect(msgs[0]!.bodyText).toContain('0xTX');
  });

  it('the RECIPIENT is pinned to the step arg, not to anything a model wrote', async () => {
    const writes: string[] = [];
    const sink = declaredEffectSink({ writeSubjectRecord: async (s) => { writes.push(s); return { ok: true }; } }, {});
    // A result claiming a different payee than the step's arg must not redirect the disclosure.
    await sink.discharge(event({ result: { txHash: '0xTX', asset: USDC, payee: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', amount: '1', payer: PAYER } }));
    expect(writes).toContain(PAYEE);
    expect(writes).not.toContain('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });

  it('an ALREADY-SETTLED payment writes nothing — the settling run holds that receipt', async () => {
    const write = vi.fn(async () => ({ ok: true }));
    const sink = declaredEffectSink({ writeSubjectRecord: write }, {});
    await sink.discharge(event({ result: { alreadySettled: true, payee: PAYEE, payer: PAYER, asset: USDC, amount: '1' } }));
    expect(write).not.toHaveBeenCalled();
  });

  it('a failed delivery THROWS — the loop turns that into EffectFailed, and the payment still stands', async () => {
    const sink = declaredEffectSink({ writeSubjectRecord: async () => ({ ok: false, error: 'record_scope_denied' }) }, {});
    await expect(sink.discharge(event())).rejects.toThrow(/not fully delivered/);
  });

  it('ignores an effect for an artifact this app cannot build', async () => {
    const write = vi.fn(async () => ({ ok: true }));
    const sink = declaredEffectSink({ writeSubjectRecord: write }, {});
    await sink.discharge(event({ effect: { ...EFFECT, produces: 'SomethingElse' } }));
    expect(write).not.toHaveBeenCalled();
  });
});

describe('the sentence is rendered from the record, never composed', () => {
  const rec: PaymentReceiptRecordV1 = {
    type: 'ap.payment-receipt.v1', payer: PAYER, payee: PAYEE, asset: USDC,
    amount: '21000000', txHash: '0xabc', runRef: 'r', mandateRef: null, settledAt: 'now',
  };
  it('names the amount, the treasury it reached and the transaction', () => {
    const t = receiptSentence(rec, { payerName: 'alice.me', payeeName: 'bob.treasury', usdc: USDC });
    expect(t).toContain('alice.me sent 21 USDC to');
    expect(t).toContain('bob.treasury');
    expect(t).toContain('0xabc');
  });
  it('an UNNAMED payee is named by whose it is — an address alone tells its owner nothing', () => {
    const t = receiptSentence(rec, { payerName: 'alice.me', payeeOwnerName: 'bob.me', usdc: USDC });
    expect(t).toContain("bob.me's treasury");
    // The address stays, for anyone who wants to check rather than believe.
    expect(t).toMatch(/\(0x[0-9a-f]{4,6}…[0-9a-f]{4}\)/);
  });
  it('an unknown asset stays in BASE UNITS rather than gaining a decimal nobody verified', () => {
    expect(receiptSentence({ ...rec, asset: '0xother' }, {})).toContain('21000000 (base units)');
  });
});
