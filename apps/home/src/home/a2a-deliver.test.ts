// spec 341 Wave 4 — delivering over A2A instead of the HMAC bridge.
//
// The transport is injected, so these assert the SHAPE OF THE CALL the recipient will authorize —
// which is the part that has to be right before any of it reaches a network. A wrong grant or a
// mismatched sender does not fail loudly at the Home; it fails at the recipient, one hop away, as an
// opaque rejection.

import { describe, it, expect } from 'vitest';
import type { Address, Hex } from '@agenticprimitives/types';
import { deliverOverA2a } from './a2a-deliver';
import { CONTRACTS } from '../lib/chain';
import { AP_DELEGATED_TASK_EXTENSION } from '@agenticprimitives/a2a/standard';

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const BODY_HASH = `0x${'cd'.repeat(32)}` as Hex;
const MSG_ID = `0x${'ef'.repeat(32)}` as Hex;

/** Captures what would have gone on the wire. */
function recordingTransport() {
  const calls: { target: Address; request: Record<string, unknown> }[] = [];
  return {
    calls,
    transport: {
      async rpc(target: Address, request: Record<string, unknown>) {
        calls.push({ target, request });
        // The A2A 1.0 answer (spec 372 S4): a task, in the 1.0 shape.
        return { jsonrpc: '2.0', id: 1, result: { task: { id: `0x${'11'.repeat(32)}`, contextId: 'c', status: { state: 'TASK_STATE_SUBMITTED' } } } };
      },
    } as never,
  };
}

const deliver = (over: Record<string, unknown> = {}) => {
  const rec = recordingTransport();
  return {
    rec,
    run: () =>
      deliverOverA2a({
        senderSA: ALICE,
        recipientSA: BOB,
        bodyRef: { owner: BOB, recordType: 'message.body:dm:msg_1' },
        bodyHash: BODY_HASH,
        messageId: MSG_ID,
        sign: async (d: Hex) => `${d.slice(0, 10)}${'00'.repeat(60)}` as Hex,
        transport: rec.transport,
        nowMs: 1_780_000_000_000,
        ...over,
      }),
  };
};

/**
 * What the Home actually put on the wire, read back in the FOLDED shape (spec 372 S4): the delegation, the
 * requester and the signed envelope live in the message's delegated-task extension. Same properties as
 * before the fold — one grant, one signature, a ref and a hash — at moved field paths.
 */
const sentParams = (rec: { calls: { request: { params?: unknown } }[] }) => {
  const params = rec.calls[0]!.request.params as { message: { metadata?: Record<string, never>; parts: { data?: unknown }[] } };
  const ext = (params.message.metadata?.[AP_DELEGATED_TASK_EXTENSION] ?? {}) as Record<string, never>;
  return { ...ext, message: ext, input: params.message.parts[0]?.data } as unknown as Record<string, never>;
};

describe('the call is an ordinary SendMessage on the A2A 1.0 wire', () => {
  it('targets the recipient with method message/send', async () => {
    const { rec, run } = deliver();
    await run();
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.target).toBe(BOB);
    expect(rec.calls[0]!.request.method).toBe('SendMessage');
  });

  // `authorizeA2aMessage` requires delegate === requester === message.sender. Making them equal by
  // CONSTRUCTION rather than convention is what stops a mismatch becoming a recipient-side rejection
  // that looks like a network fault.
  it('keeps delegate, requester and message.sender the same account', async () => {
    const { rec, run } = deliver();
    await run();
    const p = sentParams(rec) as unknown as {
      delegation: { delegator: Address; delegate: Address };
      requester: Address;
      message: { sender: Address };
    };
    expect(p.delegation.delegator).toBe(ALICE);
    expect(p.delegation.delegate).toBe(ALICE);
    expect(p.requester).toBe(ALICE);
    expect(p.message.sender).toBe(ALICE);
  });

  it('carries a grant scoped to the recipient and the delivery skill', async () => {
    const { rec, run } = deliver();
    await run();
    const p = sentParams(rec) as unknown as { delegation: { caveats: { enforcer: Address; terms: string }[] } };
    const targets = p.delegation.caveats.find((c) => c.enforcer === CONTRACTS.allowedTargetsEnforcer);
    expect(targets!.terms.toLowerCase()).toContain(BOB.slice(2).toLowerCase());
    expect(p.delegation.caveats.some((c) => c.enforcer === CONTRACTS.allowedMethodsEnforcer)).toBe(true);
  });
});

describe('two signatures, over two different things', () => {
  it('signs the grant digest and the message digest separately', async () => {
    const signed: Hex[] = [];
    const { rec, run } = deliver({
      sign: async (d: Hex) => {
        signed.push(d);
        return `${d.slice(0, 10)}${'00'.repeat(60)}` as Hex;
      },
    });
    const r = await run();
    // Exactly two, and DIFFERENT: a grant authorizes, a message attributes. Signing the same bytes
    // twice would mean one of them is not doing its job.
    expect(signed).toHaveLength(2);
    expect(signed[0]).not.toBe(signed[1]);
    expect(signed[0]).toBe(r.grantDigest);
    const p = sentParams(rec) as unknown as { message: { signature: Hex } };
    expect(p.message.signature).toBeDefined();
    expect(p.message.signature).not.toBe(p.message.signature.replace(/./g, '0'));
  });

  it('refuses to send an unsigned message', async () => {
    // The grant mint signs first, so return a real signature once then nothing — the message
    // signature is what must be caught here.
    let n = 0;
    const { run } = deliver({
      sign: async (d: Hex) => (n++ === 0 ? (`${d.slice(0, 10)}${'00'.repeat(60)}` as Hex) : ('0x' as Hex)),
    });
    await expect(run()).rejects.toThrow(/was not signed/);
  });
});

describe('the body stays in the vault', () => {
  it('sends a ref and a hash, never the bytes', async () => {
    const { rec, run } = deliver();
    await run();
    // bigint-aware, because `Delegation.salt` is a bigint — the constraint this test discovered, and
    // the one a real fetch transport has to satisfy (see `A2aDeliverInput.transport`).
    const raw = JSON.stringify(rec.calls[0]!.request, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const p = sentParams(rec) as unknown as { message: { bodyRef: { owner: Address; recordType: string }; bodyHash: Hex } };
    expect(p.message.bodyRef.recordType).toBe('message.body:dm:msg_1');
    // WHOSE vault — the recipient's, which is what lets them read it under their own authority.
    expect(p.message.bodyRef.owner).toBe(BOB);
    expect(p.message.bodyHash).toBe(BODY_HASH);
    // Nothing body-shaped on the wire — a delivery that inlined content would make the transport a
    // content store, which is what the vault exists to prevent (ADR-0055).
    expect(raw).not.toContain('bodyText');
    expect(raw).not.toContain('plaintext');
  });
});

describe('failure is failure', () => {
  it('throws when the recipient rejects, and does not fall back', async () => {
    const transport = {
      async rpc() {
        return { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'unauthorized: grant outside timestamp window' } };
      },
    } as never;
    // ADR-0013 — one mechanism per operation. A caller that caught this and wrote over the bridge
    // instead would restore exactly the authority this replaces.
    await expect(deliver({ transport }).run()).rejects.toThrow(/unauthorized/);
  });
});


describe('delivering under a pre-existing wire (spec 341 §5.1a)', () => {
  const WIRE_DELEGATE = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;
  const WIRE = { delegator: ALICE, delegate: WIRE_DELEGATE, caveats: [], signature: '0xabc' };

  it('uses the wire as-is and signs as its delegate', async () => {
    const rec = recordingTransport();
    const signed: Hex[] = [];
    await deliverOverA2a({
      senderSA: ALICE,
      recipientSA: BOB,
      bodyRef: { owner: BOB, recordType: 'message.body:dm:msg_1' },
      bodyHash: BODY_HASH,
      messageId: MSG_ID,
      sign: async (d: Hex) => { signed.push(d); return `${d.slice(0, 10)}${'00'.repeat(60)}` as Hex; },
      transport: rec.transport,
      nowMs: 1_780_000_000_000,
      wire: { delegation: WIRE, delegate: WIRE_DELEGATE },
    });

    const p = sentParams(rec) as unknown as {
      delegation: unknown; requester: Address; message: { sender: Address };
    };
    // The wire is passed through untouched — re-minting would need the person's credential, which the
    // Home does not hold, and is the entire reason the wire exists.
    expect(p.delegation).toEqual(WIRE);
    // delegate === requester === message.sender, all the SESSION KEY. The gate requires it.
    expect(p.requester).toBe(WIRE_DELEGATE);
    expect(p.message.sender).toBe(WIRE_DELEGATE);
    // ONE signature now — the message. The grant was signed once, at connect, by the person.
    expect(signed).toHaveLength(1);
  });

  it('does not mint a second grant when a wire is supplied', async () => {
    const rec = recordingTransport();
    let calls = 0;
    await deliverOverA2a({
      senderSA: ALICE,
      recipientSA: BOB,
      bodyRef: { owner: BOB, recordType: 'message.body:dm:msg_1' },
      bodyHash: BODY_HASH,
      messageId: MSG_ID,
      sign: async (d: Hex) => { calls++; return `${d.slice(0, 10)}${'00'.repeat(60)}` as Hex; },
      transport: rec.transport,
      nowMs: 1_780_000_000_000,
      wire: { delegation: WIRE, delegate: WIRE_DELEGATE },
    });
    // Two signatures would mean a grant was minted here — with the session key, producing a wire the
    // person never authorized.
    expect(calls).toBe(1);
  });
});
