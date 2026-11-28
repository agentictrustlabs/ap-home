// THE WIRES ON A PERSON'S LINK TO AN AGENT (`relationships.data`, one entry per agent: `delegations[]`).
//
// Every reader of a link takes ITS FIRST WIRE as the stewardship evidence (`@agenticprimitives/context`
// `relationshipRows`: `delegations[0]`), and `deriveStanding` verifies exactly that one. The merge used to APPEND
// whatever a write carried, so a person who joined a household as a MEMBER (the household's member-access grant
// first) and was later made a STEWARD (the household's oversight grant appended fifth) read as "a member, but not
// a steward" everywhere: the row said `steward`, the wire it was judged on was the member grant (Family Field,
// 2026-11-28 — the second steward of the demo household refused his own household's plan).
//
// So the order is part of the record:
//   · a STEWARD merge (the entry says `steward` and carries wires) puts ITS wires first — the grant that made them a
//     steward is the one every reader verifies;
//   · any other merge appends, and an entry that is already a steward KEEPS its leading wire when the list is cut;
//   · the same wire twice (by signature) is kept once, at the position the rule above gives it.
// At most `MAX_WIRES` are kept. Pure; the DO calls it.
export const MAX_WIRES = 8;

const keyOf = (w: unknown): string => {
  const sig = (w as { signature?: unknown } | null)?.signature;
  return typeof sig === 'string' && sig ? sig.toLowerCase() : JSON.stringify(w);
};
const dedupe = (wires: unknown[]): unknown[] => {
  const seen = new Set<string>();
  return wires.filter((w) => {
    if (!w || typeof w !== 'object') return false;
    const k = keyOf(w);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export function mergeRelationshipWires(input: {
  prev: unknown[] | undefined;
  incoming: unknown[] | undefined;
  /** What the merge says the person is to the agent (`entry.relationship`). */
  entryRelationship: string | undefined;
  /** What the entry is after the merge (steward ⊇ member; self is sticky). */
  resultRelationship: string;
}): unknown[] | undefined {
  const prev = Array.isArray(input.prev) ? input.prev : [];
  const incoming = Array.isArray(input.incoming) ? input.incoming : [];
  if (!Array.isArray(input.prev) && !Array.isArray(input.incoming)) return undefined;
  if (input.entryRelationship === 'steward' && incoming.length) {
    const lead = dedupe(incoming);
    const rest = dedupe(prev).filter((w) => !lead.some((l) => keyOf(l) === keyOf(w)));
    return [...lead, ...rest.slice(-(Math.max(0, MAX_WIRES - lead.length)))].slice(0, MAX_WIRES);
  }
  const all = dedupe([...prev, ...incoming]);
  if (all.length <= MAX_WIRES) return all;
  // a steward's (or a persona's) leading wire is their standing: never the one cut
  if ((input.resultRelationship === 'steward' || input.resultRelationship === 'self') && prev.length) {
    const head = all[0]!;
    return [head, ...all.slice(1).slice(-(MAX_WIRES - 1))];
  }
  return all.slice(-MAX_WIRES);
}
