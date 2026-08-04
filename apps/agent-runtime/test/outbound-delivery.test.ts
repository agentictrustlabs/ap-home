// spec 341 §5.1b — outbound delivery, performed where the key is.
//
// The assertions worth having are about the TWO IDENTITIES. Collapsing them is the failure that would
// not error: the message would send, verify, and record an agent as the author of a person's mail.

import { describe, it, expect } from 'vitest';
import type { Address, Hex } from '@agenticprimitives/types';
import { deliverOutbound, hashDeliveryBody } from '../src/outbound-delivery.js';

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const SESSION_KEY = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;
const WIRE = { delegator: ALICE, delegate: SESSION_KEY, caveats: [{ enforcer: '0x1', terms: '0x2' }], signature: '0xsig', salt: '12345' };

const caip = (a: Address): string => `eip155:84532:${a}`;
const payload = () => ({
  envelope: {
    version: 'ap.message.v2',
    id: 'msg_1',
    conversationId: 'conv_1',
    performative: 'INFORM',
    from: caip(ALICE),
    to: [caip(BOB)],
    bodyHash: `0x${'cd'.repeat(32)}`,
  },
  bodyText: 'the body itself',
});

function recording() {
  const calls: { target: Address; request: Record<string, unknown> }[] = [];
  return {
    calls,
    transport: {
      async rpc(target: Address, request: Record<string, unknown>) {
        calls.push({ target, request });
        return { jsonrpc: '2.0', id: 1, result: { taskId: `0x${'11'.repeat(32)}`, state: 'submitted' } };
      },
    } as never,
  };
}

const run = (over: Record<string, unknown> = {}) => {
  const rec = recording();
  return {
    rec,
    go: () =>
      deliverOutbound({
        personSA: ALICE,
        recipientSA: BOB,
        wire: WIRE,
        sessionKey: SESSION_KEY,
        signWithSessionKey: async (d: Hex) => `${d.slice(0, 10)}${'00'.repeat(60)}` as Hex,
        payload: payload(),
        transport: rec.transport,
        nowMs: 1_780_000_000_000,
        ...over,
      }),
  };
};

const paramsOf = (rec: ReturnType<typeof recording>) => rec.calls[0]!.request.params as Record<string, never>;

describe('two identities, never collapsed', () => {
  it('signs as the SESSION KEY on the A2A layer', async () => {
    const { rec, go } = run();
    await go();
    const p = paramsOf(rec) as unknown as { requester: Address; message: { sender: Address } };
    // The gate requires delegate === requester === message.sender, and the wire's delegate is the key.
    expect(p.requester).toBe(SESSION_KEY);
    expect(p.message.sender).toBe(SESSION_KEY);
  });

  it('carries the PERSON as the author of the envelope', async () => {
    const { rec, go } = run();
    await go();
    const p = paramsOf(rec) as unknown as { input: { envelope: { from: string } } };
    // Who SENT, as distinct from who SIGNED. The receiving skill checks this against the wire's
    // DELEGATOR (NEW-H1) — a different check, at the other end, on the other identity.
    expect(p.input.envelope.from).toBe(caip(ALICE));
  });

  it('refuses to send an envelope authored by someone else', async () => {
    const bad = payload();
    bad.envelope.from = caip(BOB);
    // The recipient would reject this anyway. Refusing here means no signature is spent and no
    // message id is burned on a message that cannot land.
    await expect(run({ payload: bad }).go()).rejects.toThrow(/envelope.from must be the person/);
  });

  it('refuses to send to an agent the envelope is not addressed to', async () => {
    await expect(run({ recipientSA: '0xcccccccccccccccccccccccccccccccccccccccc' as Address }).go())
      .rejects.toThrow(/not addressed to the recipient/);
  });
});

describe('the signed bodyHash binds the payload', () => {
  it('hashes the WHOLE skill input, the way the runtime does', async () => {
    const { rec, go } = run();
    await go();
    const p = paramsOf(rec) as unknown as { message: { bodyHash: Hex }; input: unknown };
    // The runtime rejects the task when hashBody(input) !== message.bodyHash, so a sender that hashed
    // anything narrower (just the body text, say) would produce messages that verify and then bounce.
    expect(p.message.bodyHash).toBe(hashDeliveryBody(p.input));
  });

  it('changes the hash when a single envelope field changes', async () => {
    const a = hashDeliveryBody(payload());
    const altered = payload();
    altered.envelope.id = 'msg_2';
    expect(hashDeliveryBody(altered)).not.toBe(a);
  });

  it('mints a fresh message id per send — a reused one is a replay at the gate', async () => {
    const { rec: r1, go: g1 } = run();
    const { rec: r2, go: g2 } = run();
    await g1();
    await g2();
    const id = (r: ReturnType<typeof recording>) => (paramsOf(r) as unknown as { message: { messageId: Hex } }).message.messageId;
    expect(id(r1)).not.toBe(id(r2));
  });
});

describe('the wire is spent, never minted', () => {
  it('passes the wire through untouched', async () => {
    const { rec, go } = run();
    await go();
    // Minting needs the person's custody credential, which this worker does not have and must not.
    expect((paramsOf(rec) as unknown as { delegation: unknown }).delegation).toEqual(WIRE);
  });

  it('signs exactly once — the message', async () => {
    let n = 0;
    const { go } = run({ signWithSessionKey: async (d: Hex) => { n++; return `${d.slice(0, 10)}${'00'.repeat(60)}` as Hex; } });
    await go();
    // A second signature would mean a delegation was minted here, with the session key, producing
    // authority the person never granted — and it would verify perfectly at the gate.
    expect(n).toBe(1);
  });

  it('leaves the wire JSON-serializable — salt stays a string', async () => {
    const { rec, go } = run();
    await go();
    // A `Delegation` has a bigint salt and JSON.stringify throws on it. This is asserted rather than
    // trusted because the failure appears at the transport, far from any code that looks wrong.
    expect(() => JSON.stringify(rec.calls[0]!.request)).not.toThrow();
  });
});

describe('fail-closed', () => {
  it('refuses to send an unsigned message', async () => {
    const { go } = run({ signWithSessionKey: async () => '0x' as Hex });
    await expect(go()).rejects.toThrow(/was not signed/);
  });

  it('propagates a recipient rejection rather than swallowing it', async () => {
    const transport = {
      async rpc() {
        return { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'unauthorized: grant outside timestamp window' } };
      },
    } as never;
    // A caller that caught this and wrote over the in-Worker marker instead would restore exactly the
    // authority this replaces.
    await expect(run({ transport }).go()).rejects.toThrow(/unauthorized/);
  });
});
