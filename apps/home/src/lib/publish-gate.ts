// Why the Capabilities page's "Publish for discovery" button is disabled — pure, so it can be tested
// without a browser and cannot drift from what the button actually does (the invitation-check pattern).
//
// The version this replaces said "Everything you publish is up to date" for EVERY unchanged state,
// including the common one: you have just added capabilities and left them Private. There the truthful
// answer is the opposite — there IS something to publish, and one toggle stands between you and it.
// Telling someone with work to do that there is none sends them looking for a bug in the button.

export interface PublishGateInput {
  /** How many capabilities are on the agent at all. */
  total: number;
  /** How many are marked for publishing (`asserted`). */
  marked: number;
  /** Whether the marked set differs from what is already on chain. */
  changed: boolean;
  /** A reason from the caller that outranks everything else (e.g. the agent has no public name). */
  override?: string | undefined;
}

/** `null` ⇒ the button is enabled. Otherwise the sentence to show, phrased as what to do next. */
export function publishBlockedReason({ total, marked, changed, override }: PublishGateInput): string | null {
  if (override) return override;
  if (changed) return null;
  if (total === 0) return 'Add a capability first.';
  if (marked === 0) {
    return 'Nothing is marked for publishing yet — click the ○ Private pill on a capability to make it ● Published, then publish.';
  }
  return 'Everything you publish is up to date.';
}
