/**
 * Shared input validators for every demo-a2a route (audit P1-3).
 *
 * Routes used to call `BigInt(body.salt)` and `body.owner as Address`
 * directly on attacker-controlled JSON. That gave us:
 *   - Unhandled exceptions on malformed input (500s leak stack traces).
 *   - DoS surface: 100KB decimal strings → expensive BigInt parse.
 *   - Type confusion: "0xfoo" coerced silently to `0xfoo as Address`.
 *
 * This module is the single source of truth for parsing incoming
 * fields. Every route MUST use it. Each helper:
 *   - Returns the typed value on success.
 *   - Throws `BadInputError` with a coarse `field`-tagged reason on
 *     failure. Callers catch + return 400 with the field name + a
 *     generic reason string (no internal-detail leakage).
 *   - Imposes a length cap proportional to the field's actual max
 *     to bound CPU/memory cost.
 */

import type { Address, Hex } from 'viem';

export class BadInputError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = 'BadInputError';
  }
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;
const DEC_RE = /^[0-9]+$/;

/**
 * 20-byte address with checksum casing tolerated. Case-folding to
 * lowercase is the caller's choice; this only validates the shape.
 */
export function parseAddress(field: string, v: unknown): Address {
  if (typeof v !== 'string') throw new BadInputError(field, 'expected string');
  if (v.length !== 42) throw new BadInputError(field, 'expected 0x + 40 hex chars');
  if (!ADDR_RE.test(v)) throw new BadInputError(field, 'malformed address');
  return v as Address;
}

export function parseOptionalAddress(field: string, v: unknown): Address | undefined {
  if (v === undefined || v === null) return undefined;
  return parseAddress(field, v);
}

export function parseAddressArray(field: string, v: unknown, max = 32): Address[] {
  if (!Array.isArray(v)) throw new BadInputError(field, 'expected array');
  if (v.length > max) throw new BadInputError(field, `array length ${v.length} exceeds max ${max}`);
  return v.map((x, i) => parseAddress(`${field}[${i}]`, x));
}

export function parseBytes32(field: string, v: unknown): Hex {
  if (typeof v !== 'string') throw new BadInputError(field, 'expected string');
  if (v.length !== 66) throw new BadInputError(field, 'expected 0x + 64 hex chars');
  if (!BYTES32_RE.test(v)) throw new BadInputError(field, 'malformed bytes32');
  return v as Hex;
}

/**
 * Arbitrary-length hex. `maxBytes` defaults to 64 KiB to bound payload
 * size — most tool payloads are well under 1 KiB; the cap is loose
 * but bounded, not unbounded.
 */
export function parseHex(field: string, v: unknown, opts?: { maxBytes?: number }): Hex {
  if (typeof v !== 'string') throw new BadInputError(field, 'expected string');
  if (!HEX_RE.test(v)) throw new BadInputError(field, 'malformed hex');
  const maxBytes = opts?.maxBytes ?? 65536;
  const byteLen = (v.length - 2) / 2;
  if (byteLen > maxBytes) {
    throw new BadInputError(field, `hex length ${byteLen} bytes exceeds max ${maxBytes}`);
  }
  return v as Hex;
}

/**
 * Decimal-string uint256. Bounded at 78 digits (max uint256 has 78
 * decimal digits). Rejects scientific notation, signs, leading zeros
 * beyond the obvious "0", and hex prefixes.
 */
export function parseUint256Decimal(field: string, v: unknown): bigint {
  if (typeof v !== 'string') throw new BadInputError(field, 'expected decimal string');
  if (v.length === 0 || v.length > 78) {
    throw new BadInputError(field, `decimal length out of range (got ${v.length})`);
  }
  if (!DEC_RE.test(v)) throw new BadInputError(field, 'expected base-10 digits only');
  // Reject leading zeros except for "0" itself (canonicalisation).
  if (v.length > 1 && v[0] === '0') throw new BadInputError(field, 'leading zero in decimal');
  let n: bigint;
  try {
    n = BigInt(v);
  } catch {
    throw new BadInputError(field, 'BigInt parse failed');
  }
  const MAX_UINT256 = (1n << 256n) - 1n;
  if (n > MAX_UINT256) throw new BadInputError(field, 'value exceeds uint256');
  return n;
}

export function parseOptionalUint256Decimal(field: string, v: unknown): bigint | undefined {
  if (v === undefined || v === null) return undefined;
  return parseUint256Decimal(field, v);
}

/** Bounded uint48 (typical for unix timestamps + nonces). */
export function parseUint48(field: string, v: unknown): number {
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new BadInputError(field, 'expected integer');
    if (v < 0 || v > 0xffffffffffff) throw new BadInputError(field, 'uint48 out of range');
    return v;
  }
  if (typeof v === 'string') {
    const n = parseUint256Decimal(field, v);
    if (n > 0xffffffffffffn) throw new BadInputError(field, 'uint48 out of range');
    return Number(n);
  }
  throw new BadInputError(field, 'expected uint48 (number or decimal string)');
}

/**
 * Generic safe-array bound. Catches a class of DoS where a route
 * iterates `body.items` without checking length first.
 */
export function ensureArrayBound(field: string, v: unknown, max: number): unknown[] {
  if (!Array.isArray(v)) throw new BadInputError(field, 'expected array');
  if (v.length > max) throw new BadInputError(field, `length ${v.length} exceeds max ${max}`);
  return v;
}

/**
 * Convenience helper for routes — wraps a validator that may throw
 * BadInputError into a `c.json(...)` 400 response with the field tag.
 * Use as `withBadInput(c, () => parseAddress('owner', body.owner))`.
 * The body is intentionally generic (`field` + reason); no internal
 * details leak (matches mcp-runtime's no-info-leak invariant).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function badInputResponse(c: any, e: unknown): unknown {
  if (e instanceof BadInputError) {
    return c.json({ ok: false, error: 'bad_input', field: e.field, reason: e.message }, 400);
  }
  throw e;
}
