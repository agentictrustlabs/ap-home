// Spec 436 §5.5 T3 — the two CONTEXT archetypes a town and an estate agent run under. What matters about
// them is what they do NOT carry: a context agent keeps a record and answers from it, so an assignment that
// quietly gave one an act would be the whole point lost. These are the properties the compiler produced and
// the Home will write; `ap doctor`'s archetype-catalog rule separately re-derives their digests.
import { describe, it, expect } from 'vitest';
import { ARCHETYPE_CATALOG, catalogForKind } from './archetype-catalog';
import { validateAgentHarnessDefinition, definitionDigest } from '@agenticprimitives/capability-claims';

const town = ARCHETYPE_CATALOG.find((a) => a.key === 'town-steward')!;
const estate = ARCHETYPE_CATALOG.find((a) => a.key === 'estate-steward')!;

describe('the context archetypes (spec 436 §5.5)', () => {
  it('are both in the catalog and valid against the Ring-0 schema', () => {
    for (const a of [town, estate]) {
      expect(a, `${a?.key} is in the catalog`).toBeTruthy();
      expect(validateAgentHarnessDefinition(a.definition)).toEqual({ ok: true, errors: [] });
    }
  });

  it('ACT FOR NOBODY: zero mandate types, zero approval policies, and EVERY tool an informational read', () => {
    // WHAT THIS PINS, AND WHAT IT DELIBERATELY NO LONGER PINS. It used to assert the exact list
    // `['vault.records.query']` — one tool. That read as the invariant and was only the shape of the day:
    // when the stewards learned to ask the town registry which agent does a thing (spec 413 / the registry
    // is the directory, not them), two more READS joined, and the old assertion failed for a change that
    // broke nothing it was protecting.
    //
    // The invariant is "acts for nobody", and it is about AUTHORITY, not arithmetic: no mandate type, no
    // approval policy, and not one tool that carries a capability object — because a tool without one never
    // enters the run loop's authority path at all (spec 350 §4). A context agent may read as widely as the
    // public tier allows; it may not acquire a single thing it could spend.
    for (const a of [town, estate]) {
      expect(a.definition.requiredMandateTypes, `${a.key} requires no mandate`).toEqual([]);
      expect(a.definition.approvalPolicyRefs).toEqual([]);
      expect(a.definition.tools.map((t) => t.id)).toContain('vault.records.query');
      for (const t of a.definition.tools) {
        expect(t.capability, `${a.key}: ${t.id} must be an informational read`).toBeUndefined();
        expect(t.risk, `${a.key}: ${t.id} must carry no risk floor`).toBeUndefined();
      }
    }
  });

  it('they ASK the registry rather than keeping a directory of their own', () => {
    // One directory, two doors (the owner's call, 2026-10-12): the registry is the town's public list and
    // the stewards cite it. A steward that indexed agents itself would be a second list with no way to tell
    // which was stale.
    for (const a of [town, estate]) {
      expect(a.definition.tools.map((t) => t.id)).toEqual(expect.arrayContaining(['discovery.agents.find', 'discovery.agent.inspect']));
      expect(a.definition.instructions, `${a.key} says where the answer came from`).toMatch(/registry/i);
    }
  });

  it('are offered to a .workspace agent, and not to a treasury or a person', () => {
    // The Home maps an AgentKind to a type slug; `workspace` maps to `service`. Both are named so the
    // ceremony and a deployment that reports the derived type directly agree.
    expect(catalogForKind('workspace').map((a) => a.key)).toEqual(expect.arrayContaining(['town-steward', 'estate-steward']));
    expect(catalogForKind('treasury').map((a) => a.key)).not.toContain('town-steward');
    expect(catalogForKind('person').map((a) => a.key)).not.toContain('estate-steward');
  });

  it('carry their own doctrine as instructions, not a generated stub', () => {
    expect(town.definition.instructions).toContain('You are a **Town Steward**');
    expect(estate.definition.instructions).toContain('You are an **Estate Steward**');
    // The three rules that make an answer about money and uptime worth reading.
    for (const a of [town, estate]) {
      expect(a.definition.instructions, `${a.key} refuses to read an absence as a zero`).toMatch(/absen\w+ record is an absence, never a zero/i);
      expect(a.definition.instructions, `${a.key} keeps the cost bases apart`).toMatch(/never add two of them/i);
      expect(a.definition.instructions, `${a.key} says a partial window is partial`).toMatch(/partial window is partial/i);
    }
    // An estate answers for ITS estate; the boundary is in the doctrine, not only in the data.
    expect(estate.definition.instructions).toMatch(/Another estate's figures are not in your records/);
  });

  it('reason over the pulse vocabulary', () => {
    expect(town.definition.retrievalQueries).toEqual(['TownPulse', 'Town', 'Estate']);
    expect(estate.definition.retrievalQueries).toEqual(['TownPulse', 'Estate', 'Town']);
  });

  it('are pinned by a digest the definition actually hashes to', () => {
    // An assignment pins the digest and run admission re-derives it from the embedded body: a catalog entry
    // whose digest drifted from its definition would be written and then silently ignored as a bare harness.
    expect(definitionDigest(town.definition)).toBe('0x3c800c74eeae54cc2f0eb0123907c0d5bc7953f28701f902ad574fe0857b8883');
    expect(definitionDigest(estate.definition)).toBe('0xd0547e51cd52cf0ce86904c18ec6b43dd7a05c665f9a8d5989b1e673495b1195');
  });
});
