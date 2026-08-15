// The messaging scope classes (spec 341 §5.1c) — pure-logic tests over injected deps.
// The live deps (reverse resolution, the org DO roster read) are adapters; the policy is here.
import { describe, it, expect } from 'vitest';
import { messagingScopeCovers, MESSAGING_SCOPE_SKILLS, type MessagingScopeDeps } from '../src/messaging-scope.js';

const REGISTRY = '0x1111111111111111111111111111111111111111';
const ORG = '0x2222222222222222222222222222222222222222';
const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = '0xcccccccccccccccccccccccccccccccccccccccc';

function deps(over: Partial<MessagingScopeDeps> & { named?: string[]; members?: Record<string, string[]> } = {}): MessagingScopeDeps {
  const named = new Set((over.named ?? []).map((a) => a.toLowerCase()));
  const members = over.members ?? {};
  return {
    namingRegistry: over.namingRegistry ?? REGISTRY,
    isNamed: over.isNamed ?? (async (a) => named.has(a.toLowerCase())),
    orgCoversAll:
      over.orgCoversAll ??
      (async (org, agents) => {
        const roster = new Set((members[org.toLowerCase()] ?? []).map((a) => a.toLowerCase()));
        return agents.every((a) => roster.has(a.toLowerCase()));
      }),
  };
}

const q = (over: Partial<Parameters<typeof messagingScopeCovers>[1]> = {}) => ({
  targets: [REGISTRY], sender: ALICE, recipient: BOB, skill: 'messaging.deliver', ...over,
});

describe('named-to-named (the registry scope)', () => {
  it('covers when BOTH sender and recipient hold valid names', async () => {
    expect(await messagingScopeCovers(deps({ named: [ALICE, BOB] }), q())).toBe(true);
  });
  it('a NAMELESS sender is not covered — a name is the accountability of the class', async () => {
    expect(await messagingScopeCovers(deps({ named: [BOB] }), q())).toBe(false);
  });
  it('a nameless recipient is not covered', async () => {
    expect(await messagingScopeCovers(deps({ named: [ALICE] }), q())).toBe(false);
  });
  it('an unconfigured registry leaves the scope inert', async () => {
    expect(await messagingScopeCovers(deps({ named: [ALICE, BOB], namingRegistry: '' }), q())).toBe(false);
  });
  it('resolution failure denies (fail-closed)', async () => {
    const d = deps({ isNamed: async () => { throw new Error('rpc down'); } });
    expect(await messagingScopeCovers(d, q())).toBe(false);
  });
});

describe('community (the org scope)', () => {
  it('covers when BOTH parties are current members', async () => {
    const d = deps({ members: { [ORG]: [ALICE, BOB] } });
    expect(await messagingScopeCovers(d, q({ targets: [ORG] }))).toBe(true);
  });
  it('a recipient who is NOT a current member is not covered (kick severs reach)', async () => {
    const d = deps({ members: { [ORG]: [ALICE] } });
    expect(await messagingScopeCovers(d, q({ targets: [ORG] }))).toBe(false);
  });
  it('a sender outside the org cannot ride its scope', async () => {
    const d = deps({ members: { [ORG]: [BOB, CAROL] } });
    expect(await messagingScopeCovers(d, q({ targets: [ORG] }))).toBe(false);
  });
  it('a person address in targets is not an org and covers nothing extra', async () => {
    const d = deps({ members: {} });
    expect(await messagingScopeCovers(d, q({ targets: [CAROL] }))).toBe(false);
  });
  it('roster read failure denies (fail-closed)', async () => {
    const d = deps({ orgCoversAll: async () => { throw new Error('do unreachable'); } });
    expect(await messagingScopeCovers(d, q({ targets: [ORG] }))).toBe(false);
  });
});

describe('skill restriction', () => {
  it('only the three messaging skills read scope classes', async () => {
    const d = deps({ named: [ALICE, BOB], members: { [ORG]: [ALICE, BOB] } });
    for (const skill of MESSAGING_SCOPE_SKILLS) {
      expect(await messagingScopeCovers(d, q({ targets: [REGISTRY, ORG], skill }))).toBe(true);
    }
    for (const skill of ['org.apply', 'discussion.consult', 'echo', 'orchestrate']) {
      expect(await messagingScopeCovers(d, q({ targets: [REGISTRY, ORG], skill }))).toBe(false);
    }
  });
});
