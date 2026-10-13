// WHAT THE TRACE SAYS ABOUT THE PLAYBOOK — one sentence, three states, kept out of the renderer.
//
// `playbook: null` on a run's trace means four different things, and until 2026-10-13 the Ask flyout
// rendered all four as "none (bare harness)": no assignment, a digest that does not match, a definition
// that no longer validates, and A READ THAT DID NOT HAPPEN. The fourth is the one that misleads, because
// "bare harness" reads as a settled fact about the agent — so a cold vault refusal looked like an
// unassigned archetype, and the narrowed offer set was missing for a reason nothing on screen named
// (incident `ask-mv6jof27`: 58 unnarrowed tools, `kb.question` over the steward's own skills).
//
// This is a pure function and not a branch inside the component because the three states are the thing
// worth testing, and the Home's vitest runs in `node` with no DOM: a sentence this load-bearing should not
// be testable only by driving a browser against production.
export interface PlaybookTraceView {
  playbook?: { archetypeId: string; archetypeVersion: string; digest: string } | null;
  /** Set by the runtime when the assignment record could not be READ (as opposed to not being there). */
  playbookUnreadable?: string;
}

export type PlaybookSentence =
  /** It reached the planner: the archetype, its version, the digest the definition hashes to. */
  | { kind: 'assigned'; text: string; title?: undefined }
  /** The record could not be read. NOT the same answer as having no playbook, and said so. */
  | { kind: 'unreadable'; text: string; title: string }
  /** Genuinely absent: the bare harness stands, which is a real and documented state. */
  | { kind: 'bare'; text: string; title?: undefined };

const shortDigest = (h: string) => (h.length > 14 ? `${h.slice(0, 10)}…${h.slice(-4)}` : h);

export function playbookSentence(trace: PlaybookTraceView): PlaybookSentence {
  const pb = trace.playbook;
  if (pb) {
    return {
      kind: 'assigned',
      text: `${pb.archetypeId.replace(/^skill:archetypes\//, '')} v${pb.archetypeVersion} ${shortDigest(pb.digest)}`,
    };
  }
  // ORDER MATTERS, and this is the whole point of the module: a reason to prefer over the default.
  if (trace.playbookUnreadable) {
    return {
      kind: 'unreadable',
      text: `none — its record could not be read (${trace.playbookUnreadable})`,
      title: trace.playbookUnreadable,
    };
  }
  return { kind: 'bare', text: 'none (bare harness)' };
}
