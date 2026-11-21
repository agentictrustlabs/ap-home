// THE SHAPE OF AN INTERACTIONS OP.
//
// `/interactions/<principal>/<op>` picks the Durable Object by <principal> and builds the object's internal URL from
// <op>, which the framework hands over percent-decoded. An op is dot-separated words: letters, digits and hyphens —
// no slash, backslash, percent or empty segment — so the internal URL always names the same principal the router
// chose. Checked at the router, at every in-Worker door that takes an op from a caller, and inside the object.
const OP = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)*$/;

export function isInteractionsOp(op: unknown): op is string {
  return typeof op === 'string' && op.length <= 80 && OP.test(op);
}
