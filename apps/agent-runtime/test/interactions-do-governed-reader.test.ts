/**
 * `governedBoardReader` (spec 428 §6.2) — the deny paths of the door that lets a steward of the organization a body
 * opened its content to READ that body's board.
 *
 * The same reasoning as `interactions-do-scoped-read.test.ts`: an ADMIT needs `verifyWire` — ERC-1271 against the
 * delegator and an on-chain `isRevoked` — and the object has no seam for either, so a passing admit here would be a
 * statement about stubs. The REFUSALS are the security surface, and every one of them must short-circuit BEFORE a
 * wire is verified: this env has no chain configured, so a clean `false` proves both the refusal and its ordering.
 * (The admit is proven live: `~/pokernight` `scripts/walk-field-org-steward.cjs`.)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildVaultRecordScopeCaveat } from '@agenticprimitives/delegation';

import { InteractionsDO } from '../src/interactions-do.js';

const TEAM = '0x1111111111111111111111111111111111111111';
const ORG = '0x4444444444444444444444444444444444444444';
const PERSON = '0x2222222222222222222222222222222222222222';
const OTHER_TEAM = '0x5555555555555555555555555555555555555555';

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

const reader = (governedRead: unknown): Promise<boolean> =>
  (doInstance as unknown as { governedBoardReader: (p: string, s: string, b: Record<string, unknown>) => Promise<boolean> })
    .governedBoardReader(TEAM, PERSON, governedRead === undefined ? {} : { governedRead });

/** The team → organization content grant, as the Home builds it (428 D1/D2), with whatever is overridden. */
const grant = (resources: string[], ops: string[] = ['read'], over: Record<string, unknown> = {}) => ({
  delegator: TEAM, delegate: ORG, signature: '0x03',
  caveats: [buildVaultRecordScopeCaveat([{ server: 'demo-mcp', resources, ops }])],
  ...over,
});
const DISCUSSIONS = ['vault:content.catalog', 'vault:content.artifact.*', 'vault:conversation.index', 'vault:conversation.topic:*', 'vault:message.body:topic:*'];
/** Shaped like a stewardship wire on the two fields the door reads first; it is never reached in these tests. */
const stewardship = { delegator: ORG, delegate: PERSON, caveats: [] };

describe('governedBoardReader refuses before it verifies', () => {
  it('nothing presented', async () => {
    expect(await reader(undefined)).toBe(false);
    expect(await reader({})).toBe(false);
  });

  it('the grant without proof of stewarding the organization, and the reverse', async () => {
    expect(await reader({ grant: grant(DISCUSSIONS) })).toBe(false);
    expect(await reader({ stewardship })).toBe(false);
  });

  it('a grant some OTHER body signed reads nothing here', async () => {
    expect(await reader({ grant: grant(DISCUSSIONS, ['read'], { delegator: OTHER_TEAM }), stewardship })).toBe(false);
  });

  it('a grant to the caller is a member’s own scoped read, not this door', async () => {
    expect(await reader({ grant: grant(DISCUSSIONS, ['read'], { delegate: PERSON }), stewardship })).toBe(false);
  });

  it('a body does not govern itself', async () => {
    expect(await reader({ grant: grant(DISCUSSIONS, ['read'], { delegate: TEAM }), stewardship })).toBe(false);
  });

  it('a grant with no delegate, or one that is not an address', async () => {
    expect(await reader({ grant: grant(DISCUSSIONS, ['read'], { delegate: undefined }), stewardship })).toBe(false);
    expect(await reader({ grant: grant(DISCUSSIONS, ['read'], { delegate: 'the organization' }), stewardship })).toBe(false);
  });

  it('a content grant that does not name the discussions reads no board', async () => {
    expect(await reader({ grant: grant(['vault:content.catalog', 'vault:content.artifact.*']), stewardship })).toBe(false);
  });

  it('a grant that names the discussions but not for reading', async () => {
    expect(await reader({ grant: grant(DISCUSSIONS, ['write']), stewardship })).toBe(false);
  });

  it('a wire with no record-scope caveat is not a content grant, however it is addressed', async () => {
    expect(await reader({ grant: { delegator: TEAM, delegate: ORG, signature: '0x03', caveats: [] }, stewardship })).toBe(false);
  });
});
