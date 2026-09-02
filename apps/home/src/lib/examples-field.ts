// Parsing for the capability "example queries" field — pure, so the rule can be tested without a browser.
//
// The bug this documents: the field used to be a controlled input whose displayed value was
// `parse(text).join(' | ')`, so the parse ran between one keystroke and the next. `trim()` removed a
// trailing space before the following letter arrived, and a two-word example could not be typed at all.
// The field looked like it was rejecting spaces; it was deleting them. Parsing is for what LEAVES the
// field, never for what is still being typed — which is why this function has no partner that formats
// back into the input.

/** ARD allows 2–5 representative queries; the cap is here so a projection can never over-claim. */
export const MAX_EXAMPLES = 5;

/** Split the raw field text into the examples that get stored. */
export function parseExamples(raw: string): string[] {
  return raw.split('|').map((t) => t.trim()).filter(Boolean).slice(0, MAX_EXAMPLES);
}
