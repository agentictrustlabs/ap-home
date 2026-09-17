/**
 * WHICH OF MY PEOPLE AM I — `ap:DefaultPersonChoice`.
 *
 * A custodian may hold several person agents: their own name, and a trail name, a pen name, a part in a
 * game. These are the rules that make choosing between them safe: the choice selects and never links, it
 * survives nothing it should not, and the links it chooses between stay append-only.
 */
import { describe, expect, it } from 'vitest';
import {
  listCredentialAgents, readCredentialFacet, readDefaultPerson, recordCredentialFacet, setDefaultPerson,
  type KvLike,
} from './kv-indexer';
import type { CanonicalAgentId, CredentialPrincipal } from '@agenticprimitives/types';

const memoryKv = (): KvLike & { store: Map<string, string> } => {
  const store = new Map<string, string>();
  return { store, get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } };
};
const ELENA = 'eip155:34348:0xe1e0a0000000000000000000000000000000000a' as CanonicalAgentId;
const EMILE = 'eip155:34348:0xe1e0b0000000000000000000000000000000000b' as CanonicalAgentId;
const STRANGER = 'eip155:34348:0x5555550000000000000000000000000000000055' as CanonicalAgentId;
const CRED: CredentialPrincipal = { kind: 'passkey', id: 'cred-123', assurance: 'asserted' };

const enrol = async (kv: KvLike, ...agents: CanonicalAgentId[]) => {
  for (const a of agents) await recordCredentialFacet(kv, CRED, a);
};

describe('the default person of a credential', () => {
  it('with no choice made, resolves the first agent enrolled — and says so rather than nothing', async () => {
    const kv = memoryKv();
    await enrol(kv, ELENA, EMILE);
    expect(await readDefaultPerson(kv, CRED.kind, CRED.id)).toBeNull();
    expect(await readCredentialFacet(kv, CRED.kind, CRED.id)).toBe(ELENA);
    expect(await listCredentialAgents(kv, CRED.kind, CRED.id)).toEqual([ELENA, EMILE]);
  });

  it('once chosen, resolves the chosen one however it was ordered', async () => {
    const kv = memoryKv();
    await enrol(kv, ELENA, EMILE);
    await setDefaultPerson(kv, CRED.kind, CRED.id, EMILE);
    expect(await readCredentialFacet(kv, CRED.kind, CRED.id)).toBe(EMILE);
    // …and choosing again is the normal case, not tampering: this pin is a preference, not evidence.
    await setDefaultPerson(kv, CRED.kind, CRED.id, ELENA);
    expect(await readCredentialFacet(kv, CRED.kind, CRED.id)).toBe(ELENA);
  });

  /** THE RULE THAT MAKES IT SAFE: the pin selects among what custody already proved; it never links. */
  it('refuses an agent this credential does not custody', async () => {
    const kv = memoryKv();
    await enrol(kv, ELENA);
    await expect(setDefaultPerson(kv, CRED.kind, CRED.id, STRANGER)).rejects.toThrow(/not_custodied/);
    expect(await readCredentialFacet(kv, CRED.kind, CRED.id)).toBe(ELENA);
  });

  /** A pin left behind by an agent that is no longer linked must not resolve, and must not be "corrected". */
  it('ignores a stale choice and falls back rather than inventing one', async () => {
    const kv = memoryKv();
    await enrol(kv, ELENA, EMILE);
    await setDefaultPerson(kv, CRED.kind, CRED.id, EMILE);
    kv.store.set(`facet:cred:${CRED.kind}:${CRED.id}`, JSON.stringify([{ agent: ELENA, assurance: 'asserted', ref: 'kv-cred' }]));
    expect(await readDefaultPerson(kv, CRED.kind, CRED.id)).toBe(EMILE);
    expect(await readCredentialFacet(kv, CRED.kind, CRED.id)).toBe(ELENA);
  });

  it('leaves the links append-only — choosing rewrites no evidence', async () => {
    const kv = memoryKv();
    await enrol(kv, ELENA, EMILE);
    const before = kv.store.get(`facet:cred:${CRED.kind}:${CRED.id}`);
    await setDefaultPerson(kv, CRED.kind, CRED.id, EMILE);
    expect(kv.store.get(`facet:cred:${CRED.kind}:${CRED.id}`)).toBe(before);
  });

  it('a credential with nobody on it resolves to nothing, terminally', async () => {
    const kv = memoryKv();
    expect(await readCredentialFacet(kv, CRED.kind, CRED.id)).toBeNull();
    expect(await listCredentialAgents(kv, CRED.kind, CRED.id)).toEqual([]);
  });
});
