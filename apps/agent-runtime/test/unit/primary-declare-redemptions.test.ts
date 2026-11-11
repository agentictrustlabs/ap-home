// Spec 445 / generation 4 / B1 (DLG-3) — the mandate for `treasury.primary.declare` states how many on-chain redemptions
// its step makes: one to mark, plus one per OTHER treasury of the owner it clears. Off a generation-4 estate: single use.
import { describe, expect, it } from 'vitest';
import { primaryDeclareRedemptions } from '../../src/harness-run.js';

const OWNER = '0x3b99f2b452766de5df0dbcdfc676f27257151333';
const T1 = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11';
const T2 = '0x8c5cddca27c088a65e58e94403acdc9bc3eb7fe3';
const T3 = '0x2c471607fec409516ab6de6b7517bcf95f1f2edc';
const deps = { charteredAgents: async () => [{ agent: T1 }, { agent: T2 }, { agent: T3 }] };

describe('primaryDeclareRedemptions', () => {
  it('marking counts one call plus one clear per OTHER treasury of the owner', async () => {
    expect(await primaryDeclareRedemptions(deps, { CONTRACTS_GENERATION: '4' }, OWNER, T1, true)).toBe(3);
    expect(await primaryDeclareRedemptions(deps, { CONTRACTS_GENERATION: '4' }, OWNER, T1.toUpperCase().replace('0X', '0x'), undefined)).toBe(3);
  });
  it('clearing is one call', async () => {
    expect(await primaryDeclareRedemptions(deps, { CONTRACTS_GENERATION: '4' }, OWNER, T1, false)).toBe(1);
  });
  it('an unreadable or absent list counts none (the invoker reads it the same way)', async () => {
    expect(await primaryDeclareRedemptions({ charteredAgents: async () => { throw new Error('rpc'); } }, { CONTRACTS_GENERATION: '4' }, OWNER, T1, true)).toBe(1);
    expect(await primaryDeclareRedemptions(undefined, { CONTRACTS_GENERATION: '4' }, OWNER, T1, true)).toBe(1);
  });
  it('off a generation-4 estate the count stays one — an older enforcer bounds nothing by count', async () => {
    expect(await primaryDeclareRedemptions(deps, { CONTRACTS_GENERATION: '3' }, OWNER, T1, true)).toBe(1);
    expect(await primaryDeclareRedemptions(deps, {}, OWNER, T1, true)).toBe(1);
  });
});
