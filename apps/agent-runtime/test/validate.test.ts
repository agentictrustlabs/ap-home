// The Worker's input-validation surface — untested until now, which is the wrong thing to leave
// uncovered: this module exists BECAUSE routes used to call `BigInt(body.salt)` and
// `body.owner as Address` directly on attacker-controlled JSON (audit P1-3).
//
// So these tests are written from the attacker's side rather than the happy path. Each one is a shape
// that previously reached a route: the wrong type, the right type at the wrong length, a value that
// parses but is out of range, a payload sized to make parsing itself expensive.
//
// The two properties worth stating up front, because both are load-bearing:
//
//   FAIL-CLOSED — every rejection throws `BadInputError` with a coarse field tag. A validator that
//   returned a default on bad input would push the decision into the route, which is where it was
//   before this module existed.
//
//   NO INFO LEAK — the 400 body carries `field` + a generic reason and nothing else. A validator can
//   know why something failed; the caller learns only that it did.

import { describe, it, expect } from 'vitest';
import {
  BadInputError,
  parseAddress,
  parseOptionalAddress,
  parseAddressArray,
  parseBytes32,
  parseHex,
  parseUint256Decimal,
  parseOptionalUint256Decimal,
  parseUint48,
  ensureArrayBound,
  badInputResponse,
} from '../src/validate.js';

const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/** Assert a rejection AND that it names the field — a typed throw whose tag is wrong is not better
 *  than an untyped one, because the 400 the caller sees points at the wrong input. */
function expectRejection(fn: () => unknown, field: string) {
  try {
    fn();
  } catch (e) {
    expect(e, 'expected a BadInputError').toBeInstanceOf(BadInputError);
    expect((e as BadInputError).field).toBe(field);
    return;
  }
  throw new Error('expected a rejection, got a value');
}

describe('addresses', () => {
  it('accepts a checksummed address without altering it — casing is the caller\'s business', () => {
    expect(parseAddress('owner', ADDR)).toBe(ADDR);
  });

  it('accepts the same address lowercased', () => {
    expect(parseAddress('owner', ADDR.toLowerCase())).toBe(ADDR.toLowerCase());
  });

  // `"0xfoo" as Address` was the original type-confusion bug: it type-checks and is not an address.
  it('REFUSES hex-shaped nonsense', () => {
    expectRejection(() => parseAddress('owner', '0xfoo'), 'owner');
    expectRejection(() => parseAddress('owner', `0x${'z'.repeat(40)}`), 'owner');
  });

  it('REFUSES the right characters at the wrong length', () => {
    expectRejection(() => parseAddress('owner', `0x${'a'.repeat(39)}`), 'owner');
    expectRejection(() => parseAddress('owner', `0x${'a'.repeat(41)}`), 'owner');
  });

  it('REFUSES non-strings, including the ones that coerce', () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      expectRejection(() => parseAddress('owner', bad), 'owner');
    }
  });

  it('optional means absent, not malformed', () => {
    expect(parseOptionalAddress('owner', undefined)).toBeUndefined();
    expect(parseOptionalAddress('owner', null)).toBeUndefined();
    expectRejection(() => parseOptionalAddress('owner', '0xnope'), 'owner');
  });

  it('arrays are bounded, and the failing INDEX is named', () => {
    expect(parseAddressArray('to', [ADDR, ADDR])).toHaveLength(2);
    expectRejection(() => parseAddressArray('to', 'not-an-array'), 'to');
    expectRejection(() => parseAddressArray('to', Array(33).fill(ADDR)), 'to');
    // The index matters: "one of your 32 addresses is bad" is not an actionable 400.
    expectRejection(() => parseAddressArray('to', [ADDR, '0xbad']), 'to[1]');
  });
});

describe('bytes32 and hex', () => {
  it('accepts an exact bytes32 and refuses a near-miss', () => {
    expect(parseBytes32('salt', `0x${'a'.repeat(64)}`)).toBe(`0x${'a'.repeat(64)}`);
    expectRejection(() => parseBytes32('salt', `0x${'a'.repeat(63)}`), 'salt');
    expectRejection(() => parseBytes32('salt', `0x${'a'.repeat(65)}`), 'salt');
  });

  it('accepts empty hex — `0x` is a valid zero-length payload, not a malformed one', () => {
    expect(parseHex('data', '0x')).toBe('0x');
  });

  // The DoS half of the module's reason for existing: an unbounded hex field is an unbounded parse.
  it('bounds payload size, and the bound is configurable per field', () => {
    expect(parseHex('data', `0x${'ab'.repeat(10)}`)).toBeTruthy();
    expectRejection(() => parseHex('data', `0x${'ab'.repeat(11)}`, { maxBytes: 10 }), 'data');
    // Default cap is 64 KiB — one byte over is still a rejection.
    expectRejection(() => parseHex('data', `0x${'ab'.repeat(65537)}`), 'data');
  });

  it('REFUSES hex with non-hex characters', () => {
    expectRejection(() => parseHex('data', '0xzz'), 'data');
    expectRejection(() => parseHex('data', 'deadbeef'), 'data'); // no 0x prefix
  });
});

describe('uint256 decimals', () => {
  it('accepts zero and the maximum', () => {
    expect(parseUint256Decimal('salt', '0')).toBe(0n);
    const max = (1n << 256n) - 1n;
    expect(parseUint256Decimal('salt', max.toString())).toBe(max);
  });

  // Canonical form matters because these values get hashed and compared: "01" and "1" are the same
  // number and different strings, and accepting both makes equality ambiguous.
  it('REFUSES leading zeros, but "0" itself is fine', () => {
    expect(parseUint256Decimal('salt', '0')).toBe(0n);
    expectRejection(() => parseUint256Decimal('salt', '01'), 'salt');
    expectRejection(() => parseUint256Decimal('salt', '0007'), 'salt');
  });

  it('REFUSES anything that is not base-10 digits', () => {
    for (const bad of ['-1', '1e10', '0x10', '1.0', '', ' 1', '1 ']) {
      expectRejection(() => parseUint256Decimal('salt', bad), 'salt');
    }
  });

  // The original DoS: a 100 KB decimal string is an expensive BigInt parse. Bounded at 78 digits,
  // which is the width of max uint256 — the cap is the type, not an arbitrary number.
  it('REFUSES a decimal too long to be a uint256, without parsing it', () => {
    expectRejection(() => parseUint256Decimal('salt', '9'.repeat(79)), 'salt');
    expectRejection(() => parseUint256Decimal('salt', '1'.repeat(100_000)), 'salt');
  });

  it('REFUSES a 78-digit value that is numerically over max', () => {
    // Same digit count as MAX_UINT256, larger value — length alone cannot catch this.
    expectRejection(() => parseUint256Decimal('salt', '9'.repeat(78)), 'salt');
  });

  it('optional means absent, not malformed', () => {
    expect(parseOptionalUint256Decimal('salt', undefined)).toBeUndefined();
    expect(parseOptionalUint256Decimal('salt', null)).toBeUndefined();
    expectRejection(() => parseOptionalUint256Decimal('salt', '01'), 'salt');
  });
});

describe('uint48', () => {
  it('accepts a number or a decimal string, at the boundary', () => {
    expect(parseUint48('expiry', 0)).toBe(0);
    expect(parseUint48('expiry', 0xffffffffffff)).toBe(0xffffffffffff);
    expect(parseUint48('expiry', '1700000000')).toBe(1700000000);
  });

  it('REFUSES one past the boundary, from either representation', () => {
    expectRejection(() => parseUint48('expiry', 0xffffffffffff + 1), 'expiry');
    expectRejection(() => parseUint48('expiry', String(0xffffffffffffn + 1n)), 'expiry');
  });

  it('REFUSES negatives and non-integers', () => {
    expectRejection(() => parseUint48('expiry', -1), 'expiry');
    expectRejection(() => parseUint48('expiry', 1.5), 'expiry');
    expectRejection(() => parseUint48('expiry', NaN), 'expiry');
    expectRejection(() => parseUint48('expiry', Infinity), 'expiry');
  });

  it('REFUSES types that are neither', () => {
    for (const bad of [null, undefined, {}, [], true]) {
      expectRejection(() => parseUint48('expiry', bad), 'expiry');
    }
  });
});

describe('array bounds', () => {
  it('passes a bounded array through unchanged', () => {
    expect(ensureArrayBound('items', [1, 2], 5)).toEqual([1, 2]);
  });

  it('REFUSES over-length and non-arrays — the DoS is iterating before checking', () => {
    expectRejection(() => ensureArrayBound('items', [1, 2, 3], 2), 'items');
    expectRejection(() => ensureArrayBound('items', 'nope', 2), 'items');
    expectRejection(() => ensureArrayBound('items', { length: 1 }, 2), 'items');
  });
});

describe('the 400 leaks nothing beyond the field', () => {
  const ctx = { json: (body: unknown, status: number) => ({ body, status }) };

  it('maps a BadInputError to a tagged 400', () => {
    const r = badInputResponse(ctx, new BadInputError('owner', 'malformed address')) as {
      body: { ok: boolean; error: string; field: string; reason: string }; status: number;
    };
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'bad_input', field: 'owner', reason: 'malformed address' });
  });

  // A non-BadInputError is RETHROWN, not swallowed into a 400. Turning an unexpected internal failure
  // into "bad input" would blame the caller for our bug and hide the real one.
  it('RETHROWS anything that is not a BadInputError', () => {
    expect(() => badInputResponse(ctx, new TypeError('internal'))).toThrow(TypeError);
    expect(() => badInputResponse(ctx, 'a string')).toThrow();
  });
});
