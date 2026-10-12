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

  it('ACT FOR NOBODY: zero mandate types, zero approval policies, and one informational read', () => {
    for (const a of [town, estate]) {
      expect(a.definition.requiredMandateTypes, `${a.key} requires no mandate`).toEqual([]);
      expect(a.definition.approvalPolicyRefs).toEqual([]);
      expect(a.definition.tools.map((t) => t.id)).toEqual(['vault.records.query']);
      // An informational read carries no capability object, so the run loop never enters the authority
      // path for it (spec 350 §4) — and no risk floor, because it needs none.
      const read = a.definition.tools[0]!;
      expect(read.capability).toBeUndefined();
      expect(read.risk).toBeUndefined();
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
    expect(definitionDigest(town.definition)).toBe('0x981d661f2efc5b3cc84455b1a241f6461fb89e9a8deff3ffdf11572cfe28c13a');
    expect(definitionDigest(estate.definition)).toBe('0x7976e949af5cbfff88e0d01c844af2d514a1c8426c430711cf43b583b8b37650');
  });
});
