// The adoption LADDER (ADR-0055 amendment) — the mechanism that makes the gateway transition
// incremental, so a failure is attributable to one of five causes instead of all of them at once.

import { describe, it, expect } from 'vitest';
import {
  GATEWAY_ADOPTION, adoptionStage, compareServed, shouldShadow, recordDivergence,
  SHADOW_INTERVAL_MS, DIVERGENCE_BUFFER, type Divergence,
} from '../src/gateway-adoption.js';

describe('the ledger', () => {
  it('treats an unlisted op as off', () => {
    // Opt-IN. The failure mode of opt-out is an op that moved because nobody remembered to stop it,
    // which is indistinguishable from a deliberate promotion right up until it breaks.
    expect(adoptionStage('applications.get')).toBe('off');
    expect(adoptionStage('literally.anything')).toBe('off');
  });

  it('makes every listed op say what its move puts at risk', () => {
    // The concerns list IS the reason for going one at a time — an entry without one is an op whose
    // divergence would send you back to searching all five candidates.
    for (const [op, e] of Object.entries(GATEWAY_ADOPTION)) {
      expect(e.concerns.length, op).toBeGreaterThan(0);
      expect(e.note, op).toBeTruthy();
    }
  });

  it('does not claim ordering for an op that reads one record', () => {
    // `inbox.get` reads a single vault document; it never folds the exchange stream. Claiming `ordering`
    // here would mean a clean shadow was taken as evidence about the exchange stream — the part of the
    // migration that has NOT met the amendment's rebuild conditions.
    expect(GATEWAY_ADOPTION['inbox.get'].concerns).not.toContain('ordering');
  });

  it('starts inbox.get at shadow, not serving', () => {
    expect(GATEWAY_ADOPTION['inbox.get'].stage).toBe('shadow');
  });

  it('needs the DEPLOYMENT to opt in before a shadow runs', () => {
    // The ledger says how far an op has climbed; the env says whether this deployment runs the comparison.
    // Default OFF, because shadowing hangs off `inbox.get` — which every principal polls — and would
    // otherwise construct a gateway (and its tables) in every DO as a side effect of a commit landing.
    expect(adoptionStage('inbox.get')).toBe('off');
    expect(adoptionStage('inbox.get', {})).toBe('off');
    expect(adoptionStage('inbox.get', { GATEWAY_SHADOW: 'on' })).toBe('shadow');
  });

  it('treats an empty GATEWAY_SHADOW as unset', () => {
    // `wrangler`'s `VAR = ""` binds an empty string, which `??` sails straight past — the exact shape of
    // a previous incident where a fail-closed guard was reached with a value nobody had set.
    expect(adoptionStage('inbox.get', { GATEWAY_SHADOW: '' })).toBe('off');
    expect(adoptionStage('inbox.get', { GATEWAY_SHADOW: '   ' })).toBe('off');
    expect(adoptionStage('inbox.get', { GATEWAY_SHADOW: 'ON' })).toBe('shadow'); // case is not a trap
  });
});

describe('comparison', () => {
  const AT = '2026-08-04T00:00:00.000Z';

  it('calls identical documents equal', () => {
    expect(compareServed('inbox.get', { a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }, AT).kind).toBe('equal');
  });

  it('ignores key order', () => {
    // Two planes serialising the same document differently is not a difference worth blocking a
    // promotion on, and flagging it would bury the real signal under noise on the very first run.
    expect(compareServed('inbox.get', { a: 1, b: 2 }, { b: 2, a: 1 }, AT).kind).toBe('equal');
  });

  it('catches a field that vanished', () => {
    // The data-shape drift being watched for. `{a:1}` vs `{a:1,b:undefined}` must NOT be equal.
    expect(compareServed('inbox.get', { a: 1, b: 2 }, { a: 1 }, AT).kind).toBe('value');
  });

  it('distinguishes null from absent', () => {
    expect(compareServed('inbox.get', null, undefined, AT).kind).toBe('value');
  });

  it('bounds the excerpt it keeps', () => {
    // A divergence report that embedded two whole inbox documents would put a copy of someone's mail in
    // a diagnostic buffer — the vault doctrine defeated through the back door.
    const big = (fill: string) => ({ envelopes: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, body: fill })) });
    const d = compareServed('inbox.get', big('x'), big('y'), AT);
    expect(d.kind).toBe('value');
    expect(d.detail!.length).toBeLessThan(200);
  });
});

describe('sampling', () => {
  it('always samples the first call', () => {
    // Otherwise a low-traffic principal contributes no observation for a whole deploy, and their silence
    // reads exactly like agreement.
    expect(shouldShadow({ lastShadowAt: undefined, now: 1_000, intervalMs: SHADOW_INTERVAL_MS })).toBe(true);
  });

  it('refuses a second sample inside the interval', () => {
    // The Home polls inbox.get every 5s per open tab. Shadowing each one doubles delegated vault reads on
    // the path that already hit demo-mcp's stage-2 limiter, whose rejection once surfaced as "auth failed".
    expect(shouldShadow({ lastShadowAt: 1_000, now: 6_000, intervalMs: SHADOW_INTERVAL_MS })).toBe(false);
  });

  it('samples again once the interval has passed', () => {
    expect(shouldShadow({ lastShadowAt: 1_000, now: 1_000 + SHADOW_INTERVAL_MS, intervalMs: SHADOW_INTERVAL_MS })).toBe(true);
  });

  it('keeps the added load bounded regardless of poll rate', () => {
    // The property the interval exists for, stated as a property: 5s polling for an hour must produce at
    // most one shadow per interval — not a proportion of a rate that varies with how many tabs are open.
    let last: number | undefined;
    let shadows = 0;
    for (let t = 0; t < 3_600_000; t += 5_000) {
      if (shouldShadow({ lastShadowAt: last, now: t, intervalMs: SHADOW_INTERVAL_MS })) { shadows++; last = t; }
    }
    expect(shadows).toBeLessThanOrEqual(3_600_000 / SHADOW_INTERVAL_MS + 1);
  });
});

describe('the evidence buffer', () => {
  it('records agreement as well as difference', () => {
    // A buffer holding only differences cannot tell "the planes agree" from "the shadow never ran", and
    // those justify opposite decisions about promoting.
    const buf = recordDivergence([], { op: 'inbox.get', at: 'x', kind: 'equal' });
    expect(buf).toHaveLength(1);
  });

  it('stays bounded', () => {
    let buf: Divergence[] = [];
    for (let i = 0; i < DIVERGENCE_BUFFER * 3; i++) buf = recordDivergence(buf, { op: 'inbox.get', at: `t${i}`, kind: 'equal' });
    expect(buf).toHaveLength(DIVERGENCE_BUFFER);
    expect(buf.at(-1)!.at).toBe(`t${DIVERGENCE_BUFFER * 3 - 1}`); // keeps the NEWEST, not the first ones seen
  });
});

// ── Against the REAL document, not a toy one ──────────────────────────────────────────────────────────
//
// The comparison above runs on `{a:1,b:2}`. What the two planes actually exchange is an `InboxDataV1`:
// nested, optional-heavy, with several dictionaries and four parallel arrays. Every interesting way this
// harness can be wrong — a `Record` whose key order differs, an optional field present-but-undefined on
// one side, an array whose order carries meaning — only shows up in a document with those features.
describe('comparison against a real InboxDataV1', () => {
  const AT = '2026-08-04T00:00:00.000Z';
  const doc = (over: Record<string, unknown> = {}) => ({
    version: 1,
    envelopes: [
      { id: 'msg_a', from: '0xaaa', to: '0xbbb', kind: 'dm', at: '2026-08-01T00:00:00.000Z', bodyHash: '0x11' },
      { id: 'msg_b', from: '0xccc', to: '0xbbb', kind: 'dm', at: '2026-08-02T00:00:00.000Z', bodyHash: '0x22' },
    ],
    events: [{ messageId: 'msg_a', eventType: 'delivered', at: '2026-08-01T00:00:01.000Z' }],
    draftCases: [],
    caseEvents: [],
    cards: { ixn_1: { title: 'Approve', actions: ['approve', 'deny'] } },
    ...over,
  });

  it('calls two reads of the same document equal', () => {
    expect(compareServed('inbox.get', doc(), doc(), AT).kind).toBe('equal');
  });

  it('is unmoved by key order inside the cards dictionary', () => {
    // `cards` is a Record. Two JSON serialisations of the same map can order keys differently, and
    // flagging that would mark a healthy shadow as diverging on its first run with more than one card.
    const a = doc({ cards: { ixn_1: { title: 'A', actions: ['approve'] }, ixn_2: { title: 'B', actions: ['deny'] } } });
    const b = doc({ cards: { ixn_2: { title: 'B', actions: ['deny'] }, ixn_1: { title: 'A', actions: ['approve'] } } });
    expect(compareServed('inbox.get', a, b, AT).kind).toBe('equal');
  });

  it('catches a DROPPED envelope', () => {
    // The failure that matters most and shows least: the caller renders a shorter list and nothing errors.
    const short = doc({ envelopes: [doc().envelopes[0]] });
    expect(compareServed('inbox.get', doc(), short, AT).kind).toBe('value');
  });

  it('catches REORDERED envelopes', () => {
    // Array order is not sorted away, deliberately: `envelopes` is a sequence, and a plane that returned
    // the same messages in a different order has changed what the person sees. Both planes read the same
    // stored bytes, so a reorder here is a real defect and not an artefact of serialisation.
    const flipped = doc({ envelopes: [doc().envelopes[1], doc().envelopes[0]] });
    expect(compareServed('inbox.get', doc(), flipped, AT).kind).toBe('value');
  });

  it('catches an optional section that turned into an empty one', () => {
    // `mandates`/`conversations` are optional. Absent and `{}` are different documents, and a plane that
    // helpfully filled in a default would be changing the record on the way out.
    expect(compareServed('inbox.get', doc(), doc({ mandates: {} }), AT).kind).toBe('value');
  });

  it('catches a changed bodyHash while everything else matches', () => {
    // The single-field change with the largest consequence: bodies are hash-verified against the envelope
    // (spec 309 §8.4), so a plane serving a different `bodyHash` makes the body unverifiable — and every
    // count, id and timestamp around it still lines up.
    const tampered = doc();
    tampered.envelopes[1].bodyHash = '0x99';
    const d = compareServed('inbox.get', doc(), tampered, AT);
    expect(d.kind).toBe('value');
    expect(d.detail).toContain('@'); // and it points at where, not just that
  });

  it('keeps the excerpt small even for a full inbox', () => {
    const big = (h: string) => doc({
      envelopes: Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, from: '0xaaa', to: '0xbbb', kind: 'dm', at: AT, bodyHash: h })),
    });
    expect(compareServed('inbox.get', big('0x11'), big('0x22'), AT).detail!.length).toBeLessThan(200);
  });
});
