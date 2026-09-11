// THIS RUNTIME'S adoption ledger (ADR-0060). The ladder's mechanics — comparison, sampling, the buffer, race
// classification — are `@agenticprimitives/fabric`'s and tested there (spec 399 W0 promotion); what is tested
// here is what the ledger CLAIMS about this runtime's ops, and that the comparison holds on a real inbox document.

import { describe, it, expect } from 'vitest';
import { compareServed } from '@agenticprimitives/fabric';
import { GATEWAY_ADOPTION, gatewayStage } from '../src/gateway-adoption.js';

describe('the ledger', () => {
  it('treats an unlisted op as off', () => {
    // Opt-IN. The failure mode of opt-out is an op that moved because nobody remembered to stop it,
    // which is indistinguishable from a deliberate promotion right up until it breaks.
    expect(gatewayStage('applications.get')).toBe('off');
    expect(gatewayStage('literally.anything')).toBe('off');
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
    expect(gatewayStage('inbox.get')).toBe('off');
    expect(gatewayStage('inbox.get', {})).toBe('off');
    expect(gatewayStage('inbox.get', { GATEWAY_SHADOW: 'on' })).toBe('shadow');
  });

  it('treats an empty GATEWAY_SHADOW as unset', () => {
    // `wrangler`'s `VAR = ""` binds an empty string, which `??` sails straight past — the exact shape of
    // a previous incident where a fail-closed guard was reached with a value nobody had set.
    expect(gatewayStage('inbox.get', { GATEWAY_SHADOW: '' })).toBe('off');
    expect(gatewayStage('inbox.get', { GATEWAY_SHADOW: '   ' })).toBe('off');
    expect(gatewayStage('inbox.get', { GATEWAY_SHADOW: 'ON' })).toBe('shadow'); // case is not a trap
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

// ── G-4: classifying the noise BEFORE the evidence arrives ────────────────────────────────────────────
describe('volatile fields are declared per op, not discovered', () => {
  it('makes every ledger entry state its volatile fields', () => {
    // Declared before evidence, because classifying noise AFTER seeing a report is how a real divergence
    // gets explained away as expected.
    for (const [op, e] of Object.entries(GATEWAY_ADOPTION)) {
      expect(Array.isArray(e.volatileFields), op).toBe(true);
    }
  });

  it('claims NONE for inbox.get, and that is a claim', () => {
    // Both planes read the same stored document and `inboxRevision` is a pure content hash — no clock, no
    // counter, nothing computed per read. An empty list here asserts that; it is not an omission.
    expect(GATEWAY_ADOPTION['inbox.get'].volatileFields).toEqual([]);
    expect(GATEWAY_ADOPTION['inbox.get'].note).toMatch(/race|raced/i);
  });
});

