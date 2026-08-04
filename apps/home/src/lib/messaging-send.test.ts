// spec 341 §5.1b — the client side of "the person's agent sends it".
//
// Two things here are worth testing and neither is the happy path. The first is that a blocked send
// is DISTINGUISHABLE: "you have not approved this contact" and "the recipient's gate refused you" look
// identical at the HTTP layer and have opposite remedies. The second is the UNION in the ceremony — a
// re-mint that dropped existing counterparties would break sending to them with nothing erroring.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Address } from '@agenticprimitives/types';

vi.mock('../csrf', () => ({ ensureCsrfToken: async () => undefined, csrfHeaders: () => ({}) }));
vi.mock('./sso-cookie', () => ({ readSsoCookie: () => ({ token: 'tok' }) }));
// `SESSION_KEY` is a plain string constant that happens to live in a `.tsx` module; importing it
// drags the whole React context (and its JSX) into a test that needs none of it.
vi.mock('../context/session', () => ({ SESSION_KEY: 'agenticprimitives:home:session' }));

const { sendMessage, readMessagingWire, approveMessagingRecipient, putMessagingWire, MessagingWireRequiredError } = await import('./messaging-send');

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const CAROL = '0xcccccccccccccccccccccccccccccccccccccccc' as Address;
const KEY = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;

interface Call { url: string; body: Record<string, unknown> }
let calls: Call[];

function stubFetch(responder: (url: string) => { status?: number; body: Record<string, unknown> }): void {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    const r = responder(url);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body } as Response;
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', { getItem: () => null });
});

describe('the send goes to the person’s own agent', () => {
  it('posts messaging.send to the sender’s own DO, carrying the session', async () => {
    stubFetch(() => ({ body: { ok: true, messageId: 'msg_1', conversationId: 'conv_1', taskId: '0x11' } }));
    const out = await sendMessage({ person: ALICE, recipient: BOB, bodyText: 'hi' });
    // The Home is not in this path at all — that is the change.
    expect(calls[0]!.url).toBe(`/a2a/interactions/${ALICE}/messaging.send`);
    expect(calls[0]!.body.session).toBe('tok');
    expect(out.messageId).toBe('msg_1');
    expect(out.taskId).toBe('0x11');
  });

  it('sends only the recipient key the caller chose', async () => {
    stubFetch(() => ({ body: { ok: true } }));
    await sendMessage({ person: ALICE, recipientName: 'bob.impact', bodyText: 'hi' });
    // Not a chain the agent walks until something answers: exactly one way to name the recipient
    // arrives, so an unresolvable name fails rather than silently becoming a different send.
    expect(calls[0]!.body.recipientName).toBe('bob.impact');
    expect(calls[0]!.body.recipient).toBeUndefined();
    expect(calls[0]!.body.conversationId).toBeUndefined();
  });
});

describe('a blocked send is distinguishable from a refused one', () => {
  it('raises the ceremony error when there is no wire', async () => {
    stubFetch(() => ({ status: 409, body: { code: 'wire_absent', error: 'no messaging wire', sessionKey: KEY } }));
    await expect(sendMessage({ person: ALICE, recipient: BOB, bodyText: 'hi' })).rejects.toBeInstanceOf(MessagingWireRequiredError);
  });

  it('raises it for an unapproved contact, naming who to approve', async () => {
    stubFetch(() => ({
      status: 409,
      body: { code: 'recipient_not_in_wire', error: 'not covered', recipient: CAROL, recipients: [BOB], sessionKey: KEY },
    }));
    const err = await sendMessage({ person: ALICE, recipient: CAROL, bodyText: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(MessagingWireRequiredError);
    // The UI needs BOTH: who to add, and who is already covered — the second is what the re-mint
    // must preserve.
    expect(err.recipient).toBe(CAROL);
    expect(err.currentRecipients).toEqual([BOB]);
  });

  it('does NOT raise it for a genuine gate rejection', async () => {
    stubFetch(() => ({ status: 409, body: { error: 'delivery rejected by the recipient: delegation revoked' } }));
    const err = await sendMessage({ person: ALICE, recipient: BOB, bodyText: 'hi' }).catch((e) => e);
    // Same status code, opposite remedy. Signing again would not help, and offering to would be a
    // loop the person cannot escape.
    expect(err).not.toBeInstanceOf(MessagingWireRequiredError);
    expect(String(err.message)).toMatch(/revoked/);
  });
});

describe('the ceremony carries existing counterparties forward', () => {
  it('mints over the UNION of current targets and the new one', async () => {
    stubFetch((url) =>
      url.endsWith('messaging.wireStatus')
        ? { body: { ok: true, sessionKey: KEY, wirePresent: true, recipients: [BOB] } }
        : { body: { ok: true } },
    );
    let minted: { recipients: Address[] } | null = null;
    await approveMessagingRecipient({
      person: ALICE,
      newRecipient: CAROL,
      mintWire: async (i) => { minted = i; return { wire: true }; },
    });
    // A wire naming only Carol would replace the one naming Bob, and messages to Bob would start
    // bouncing at his gate with nothing here having failed.
    expect(minted!.recipients).toEqual([BOB, CAROL]);
  });

  it('deduplicates a contact that is already covered', async () => {
    stubFetch((url) =>
      url.endsWith('messaging.wireStatus')
        ? { body: { ok: true, sessionKey: KEY, wirePresent: true, recipients: [BOB] } }
        : { body: { ok: true } },
    );
    let minted: { recipients: Address[] } | null = null;
    await approveMessagingRecipient({ person: ALICE, newRecipient: BOB, mintWire: async (i) => { minted = i; return {}; } });
    expect(minted!.recipients).toEqual([BOB]);
  });

  it('refuses to mint when the deployment has no session key', async () => {
    stubFetch(() => ({ body: { ok: true, sessionKey: null, wirePresent: false, recipients: [] } }));
    let called = false;
    // The delegate is the whole point of the wire. Minting without one would produce a delegation to
    // nobody, signed by the person, which is worse than refusing.
    await expect(
      approveMessagingRecipient({ person: ALICE, newRecipient: BOB, mintWire: async () => { called = true; return {}; } }),
    ).rejects.toThrow(/no interactions session key/);
    expect(called).toBe(false);
  });

  it('aborts rather than minting narrower when the status read fails', async () => {
    stubFetch(() => ({ status: 503, body: { error: 'unavailable' } }));
    let called = false;
    await expect(
      approveMessagingRecipient({ person: ALICE, newRecipient: CAROL, mintWire: async () => { called = true; return {}; } }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe('reading the wire', () => {
  it('reports what the agent says it holds, not what the caller assumed', async () => {
    stubFetch(() => ({ body: { ok: true, sessionKey: KEY, wirePresent: true, recipients: [BOB, CAROL], enabledAt: '2026-08-03T00:00:00Z' } }));
    const r = await readMessagingWire(ALICE);
    expect(r).toEqual({ sessionKey: KEY, wirePresent: true, recipients: [BOB, CAROL], enabledAt: '2026-08-03T00:00:00Z' });
  });
});

describe('a minted wire is not a transportable wire', () => {
  // Found by the live run, not by a unit test: `issueMessagingWire` returns a bigint salt, the POST
  // threw "Do not know how to serialize a BigInt", and the screen showed that sentence next to an
  // Approve button — a message about JSON where the reader needed a message about signing.
  it('refuses a bigint salt with a message that names the fix', async () => {
    stubFetch(() => ({ body: { ok: true } }));
    await expect(putMessagingWire(ALICE, { delegator: ALICE, salt: 1n })).rejects.toThrow(/toWire/);
    expect(calls).toHaveLength(0);
  });

  it('accepts the transport form', async () => {
    stubFetch(() => ({ body: { ok: true } }));
    await putMessagingWire(ALICE, { delegator: ALICE, salt: '1' });
    expect(calls[0]!.url).toBe(`/a2a/interactions/${ALICE}/messaging.wireEnable`);
  });
});
