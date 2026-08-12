/**
 * `hasScopedAccess` — the deny paths, which are the whole security surface of scoped reads.
 *
 * WHY THESE AND NOT AN END-TO-END ADMIT. An ADMIT requires `verifyWire` — ERC-1271 against the
 * delegator plus an on-chain `isRevoked` — and `InteractionsDO` has no deps seam for either (the
 * finding already recorded at the top of `interactions-do-gate.test.ts`). So a passing admit here
 * would be a statement about stubs.
 *
 * The REFUSALS need no such thing, and they are the cases that matter: every one of them must
 * short-circuit BEFORE the wire is verified. That is testable exactly, and it is what these assert —
 * each returns false with no chain access configured at all, which also proves the ordering.
 *
 * THE TRAP THIS FILE EXISTS FOR: `vaultRecordScopeAllows` returns TRUE for an empty scope set, on the
 * correct reasoning that an unscoped grant is unrestricted. Reused naively for admission that inverts
 * into "any wire with no record-scope caveat reads anything" — including a stewardship wire that
 * arrived on the wrong field. The caveat's PRESENCE is what makes a wire a data grant, so its absence
 * has to fail before the matcher is ever consulted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildVaultRecordScopeCaveat, VAULT_RECORD_SCOPE_ENFORCER } from '@agenticprimitives/delegation';

import { InteractionsDO } from '../src/interactions-do.js';

const ORG = '0x1111111111111111111111111111111111111111';
const PERSON = '0x2222222222222222222222222222222222222222';
const STRANGER = '0x3333333333333333333333333333333333333333';
const RESOURCE = 'content.artifact.eng-1bpk01x-fcsoma';

/** No CHAIN_RPC_URL and no DELEGATION_MANAGER: any path that reaches `verifyWire` would throw or
 *  fail, so a clean `false` proves the refusal happened before it. */
const env = () => ({ CHAIN_ID: '84532' }) as never;

let doInstance: InteractionsDO;
beforeEach(() => {
  const m = new Map<string, unknown>();
  const storage = {
    async get(k: string) { return m.get(k); },
    async put(k: string, v: unknown) { m.set(k, v); },
    async delete(k: string) { m.delete(k); },
  };
  doInstance = new InteractionsDO({ storage } as unknown as DurableObjectState, env());
});

/** `hasScopedAccess` is private; TS visibility is compile-time only and the behaviour is the contract. */
const scopedRead = (wire: unknown, resource = RESOURCE): Promise<boolean> =>
  (doInstance as unknown as {
    hasScopedAccess: (p: string, s: string, w: unknown, r: string, o: string) => Promise<{ ok: boolean }>;
  }).hasScopedAccess(ORG, PERSON, wire, resource, 'read').then((r) => r.ok);

/** The op a content call asks for — the module-level decision, testable without a DO. */
const scopedContentOp = (op: string, resource: string, data: unknown) => {
  if (op === 'content.get') return { resource, op: 'read' as const };
  if (op !== 'content.put') return undefined;
  if (!resource.startsWith('content.artifact.')) return undefined;
  return { resource, op: data === null ? ('delete' as const) : ('write' as const) };
};

const wireWith = (resources: string[], ops: string[] = ['read'], over: Record<string, unknown> = {}) => ({
  delegator: ORG,
  delegate: PERSON,
  caveats: [buildVaultRecordScopeCaveat([{ server: 'demo-mcp', resources, ops }])],
  ...over,
});

describe('hasScopedAccess refuses before it verifies', () => {
  it('no wire at all', async () => {
    expect(await scopedRead(undefined)).toBe(false);
  });

  it('no resource named — nothing to match a scope against', async () => {
    expect(await scopedRead(wireWith(['vault:content.artifact.*']), '')).toBe(false);
  });

  /* THE TRAP. An unscoped wire must not inherit `vaultRecordScopeAllows`'s permissive empty case. */
  it('a wire with NO record-scope caveat grants nothing, however well-formed', async () => {
    expect(await scopedRead({ delegator: ORG, delegate: PERSON, caveats: [] })).toBe(false);
  });

  it('a stewardship-shaped wire on the scoped field grants nothing', async () => {
    // Governance targets, no record scope — the positive stewardship shape. It is somebody's real
    // authority, and it is still not a scoped read grant.
    const steward = {
      delegator: ORG,
      delegate: PERSON,
      caveats: [{ enforcer: '0xb06252fad1d41b9943c73ec696af70f268581625', terms: '0x' }],
    };
    expect(await scopedRead(steward)).toBe(false);
  });

  it('undecodable terms grant nothing', async () => {
    expect(await scopedRead({
      delegator: ORG,
      delegate: PERSON,
      caveats: [{ enforcer: VAULT_RECORD_SCOPE_ENFORCER, terms: '0xdeadbeef' }],
    })).toBe(false);
  });

  it('a scope that does not cover the resource', async () => {
    expect(await scopedRead(wireWith(['vault:content.artifact.field-observation.*']))).toBe(false);
  });

  it('a scope covering the resource but WITHOUT the read op', async () => {
    expect(await scopedRead(wireWith(['vault:content.artifact.*'], ['write']))).toBe(false);
  });

  it('a wire delegated to somebody else', async () => {
    expect(await scopedRead(wireWith(['vault:content.artifact.*'], ['read'], { delegate: STRANGER }))).toBe(false);
  });

  it('a wire delegated BY somebody else', async () => {
    expect(await scopedRead(wireWith(['vault:content.artifact.*'], ['read'], { delegator: STRANGER }))).toBe(false);
  });
});

/**
 * WHICH QUESTION A CONTENT OP ASKS. Mirrors `scopedContentOp` in the DO; these are the two mappings
 * that carry real consequence, and both are easy to get silently wrong.
 */
describe('scoped admission maps the op honestly', () => {
  const ART = 'content.artifact.field-phase-results-100395rop3-weld-1bpk01x';

  it('a read is a read', () => {
    expect(scopedContentOp('content.get', ART, undefined)?.op).toBe('read');
  });

  it('a put with data is a write', () => {
    expect(scopedContentOp('content.put', ART, { any: 'thing' })?.op).toBe('write');
  });

  /* `delRecord` sends content.put with data: null. Calling that a write would let `ops: ['write']`
     erase records — a grant to change a thing is not a grant to remove it. */
  it('a put with NULL data is a DELETE, not a write', () => {
    expect(scopedContentOp('content.put', ART, null)?.op).toBe('delete');
  });

  /* The catalog lists every artifact in the org. A scoped writer who could rewrite it could drop
     another community's records while holding a grant naming only their own. No scope string buys
     this, so it is refused before the wire is even consulted. */
  it('WRITING the catalog is never scoped — it is the org-wide index', () => {
    expect(scopedContentOp('content.put', 'content.catalog', [])).toBeUndefined();
    expect(scopedContentOp('content.put', 'content.catalog', null)).toBeUndefined();
  });

  it('ops other than content.* are not scoped at all', () => {
    expect(scopedContentOp('applications.put', ART, {})).toBeUndefined();
    expect(scopedContentOp('invite.put', ART, {})).toBeUndefined();
  });
});
