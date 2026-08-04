// spec 341 §5.1b — outbound delivery, performed where the key is.
//
// The assertions worth having are about the TWO IDENTITIES. Collapsing them is the failure that would
// not error: the message would send, verify, and record an agent as the author of a person's mail.

import { describe, it, expect } from 'vitest';
import type { Address, Hex } from '@agenticprimitives/types';
import { deliverOutbound, hashDeliveryBody, wireTargets } from '../src/outbound-delivery.js';
import { encodeAllowedTargetsTerms } from '@agenticprimitives/delegation';

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const SESSION_KEY = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;
// The TRANSPORT grant: person → person, carrying the caveats. See `outbound-delivery.ts` for why the
// sender cannot be the key.
const GRANT = { delegator: ALICE, delegate: ALICE, caveats: [{ enforcer: '0x1', terms: '0x2' }], signature: '0xsig', salt: '12345' };
const wrapped = (d: Hex): Hex => `0x51${d.slice(2, 10)}${'00'.repeat(60)}` as Hex;

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
        transportGrant: GRANT,
        signAsPerson: async (d: Hex) => wrapped(d),
        payload: payload(),
        transport: rec.transport,
        nowMs: 1_780_000_000_000,
        ...over,
      }),
  };
};

const paramsOf = (rec: ReturnType<typeof recording>) => rec.calls[0]!.request.params as Record<string, never>;

describe('two identities, never collapsed', () => {
  it('sends as the PERSON\u2019s agent, never as the key', async () => {
    const { rec, go } = run();
    await go();
    const p = paramsOf(rec) as unknown as { requester: Address; message: { sender: Address; signature: Hex } };
    // The gate requires delegate === requester === message.sender (hence the self-delegated transport
    // grant) and verifies that sender with a check demanding DEPLOYED code. A key has none, so a key
    // can never be a sender \u2014 the failure that shipped once and was found only by the live e2e.
    expect(p.requester).toBe(ALICE);
    expect(p.message.sender).toBe(ALICE);
    // The key\u2019s participation is inside the signature, with the wire that authorizes it.
    expect(p.message.signature.startsWith('0x51')).toBe(true);
  });

  it('refuses to send a PLAIN signature', async () => {
    // Produced by the right key over the right digest, and refused at every recipient, because nothing
    // in it says which identity that key may speak for.
    await expect(run({ signAsPerson: async (d: Hex) => `${d.slice(0, 10)}${'00'.repeat(60)}` as Hex }).go())
      .rejects.toThrow(/session-wrapped/);
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
  it('passes the transport grant through untouched', async () => {
    const { rec, go } = run();
    await go();
    // Minting needs the person's custody credential, which this worker does not have and must not.
    expect((paramsOf(rec) as unknown as { delegation: unknown }).delegation).toEqual(GRANT);
  });

  it('signs exactly once — the message', async () => {
    let n = 0;
    const { go } = run({ signAsPerson: async (d: Hex) => { n++; return wrapped(d); } });
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
    const { go } = run({ signAsPerson: async () => '0x' as Hex });
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

describe('reading what a wire authorizes', () => {
  const ENF = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const withTargets = (targets: Address[]) => ({
    caveats: [{ enforcer: ENF, terms: encodeAllowedTargetsTerms(targets) }],
  });

  it('decodes the caveat, which is what the recipient’s gate enforces', () => {
    const r = wireTargets(withTargets([BOB, SESSION_KEY]), ENF);
    expect(r).toEqual({ ok: true, targets: [BOB.toLowerCase(), SESSION_KEY.toLowerCase()] });
  });

  it('matches the enforcer case-insensitively', () => {
    expect(wireTargets(withTargets([BOB]), ENF.toUpperCase().replace('0X', '0x')).ok).toBe(true);
  });

  it('reports an ABSENT targets caveat, not an empty contact list', () => {
    // An unbounded wire and a wire covering nobody are different facts with different remedies. The
    // gate refuses the first outright; reporting it as "you have not approved anyone" would send the
    // person into a ceremony that cannot help.
    expect(wireTargets({ caveats: [{ enforcer: '0x1', terms: '0x2' }] }, ENF)).toEqual({ ok: false, reason: 'absent' });
    expect(wireTargets({ caveats: [] }, ENF)).toEqual({ ok: false, reason: 'absent' });
    expect(wireTargets(undefined, ENF)).toEqual({ ok: false, reason: 'absent' });
  });

  it('reports UNDECODABLE terms rather than throwing into the request path', () => {
    expect(wireTargets({ caveats: [{ enforcer: ENF, terms: '0xdeadbeef' }] }, ENF)).toEqual({ ok: false, reason: 'undecodable' });
  });

  it('refuses to answer when the enforcer address is unconfigured', () => {
    // Empty config used to mean "find no caveat" ⇒ empty targets ⇒ every send looks unapproved. Worse,
    // the mirror-image bug in a membership check fails OPEN (audit NEW-H2). Say "undecodable".
    for (const bad of [undefined, '', '0x', 'not-an-address']) {
      expect(wireTargets(withTargets([BOB]), bad), String(bad)).toEqual({ ok: false, reason: 'undecodable' });
    }
  });
});

// ── A PAYLOAD THAT IS NOT AN ENVELOPE (spec 341 §5.5a) ────────────────────────────────────────────────
//
// `org.apply` rides the same authorized rail as a message but is not an envelope. This module assumed
// every payload had one and read `payload.envelope.from` unconditionally; the call site passed
// `as never` to get past the compiler, so the mismatch shipped and surfaced at the ORG as
// "application rejected by the organization: Cannot read properties of undefined (reading 'from')" —
// a TypeError wearing a policy refusal's clothes, which is the most expensive kind of error to read.
//
// These tests exist because the type no longer forbids it and nothing else would notice if it came back.
describe('a non-envelope payload (org.apply)', () => {
  const application = () => ({ message: 'please let me in', org: BOB });

  it('delivers without an envelope', async () => {
    const { rec, go } = run({ payload: application(), skill: 'org.apply' });
    await go();
    expect(rec.calls).toHaveLength(1);
    const msg = (rec.calls[0]!.request.params as { message: Record<string, unknown> }).message;
    expect(msg.skill).toBe('org.apply');
  });

  it('still names the PERSON as the sender', async () => {
    // The gate requires delegate === requester === message.sender, and the receiving skill takes the
    // applicant from the verified principal. An application that arrived as the session key would be
    // recorded against a key rather than a person — or refused outright.
    const { rec, go } = run({ payload: application(), skill: 'org.apply' });
    await go();
    const msg = (rec.calls[0]!.request.params as { message: Record<string, unknown> }).message;
    expect(String(msg.sender).toLowerCase()).toBe(ALICE.toLowerCase());
  });

  it('still session-wraps the signature and carries the transport grant', async () => {
    // Dropping the envelope check must not drop the authority that made the call legitimate. This is the
    // assertion that keeps "exempt from a field it does not have" from becoming "exempt".
    const { rec, go } = run({ payload: application(), skill: 'org.apply' });
    await go();
    const params = rec.calls[0]!.request.params as { message: Record<string, unknown>; delegation: unknown };
    expect(String(params.message.signature).startsWith('0x51')).toBe(true);
    // The grant travels as `params.delegation`, NOT on the message — the shape the existing
    // envelope tests already assert. My first version read `message.delegation`, got `undefined`, and
    // would have "passed" against any other wrong location had I asserted merely that it was truthy.
    expect(params.delegation).toEqual(GRANT);
  });

  it('hashes the application body so the runtime accepts it', async () => {
    // The a2a runtime rejects the task when hashBody(input) !== message.bodyHash, so a non-envelope
    // payload has to be hashed the same way an envelope one is.
    const { rec, go } = run({ payload: application(), skill: 'org.apply' });
    await go();
    const params = rec.calls[0]!.request.params as { message: Record<string, unknown>; input: unknown };
    expect(params.message.bodyHash).toBe(hashDeliveryBody(params.input));
  });

  it('STILL rejects an envelope whose from is not the person', async () => {
    // The positive control for the guard that was loosened: making `envelope` optional must not make the
    // check optional when an envelope IS present.
    const bad = { ...payload(), envelope: { ...payload().envelope, from: caip(BOB) } };
    await expect(run({ payload: bad }).go()).rejects.toThrow(/envelope\.from must be the person/);
  });
});
