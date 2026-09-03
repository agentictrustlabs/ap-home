// SESSION WIRES — now the package's, not this app's.
//
// The implementation moved to `@agenticprimitives/a2a` (`session-wire.ts`) in spec 350 W1: it was the
// SECOND of four copies across two repos, and "copy the wire implementation, do not invent a third" had
// been overtaken by events. Every symbol below is the package's, re-exported under the names this app
// already used so its call sites did not have to change in the same commit. The app-local
// `IncomingDelegation` is structurally the package's `DelegationWireV1`, and the alias says so.
//
// What did NOT move: policy. `org-wire.ts` decides which caveat SHAPE counts as stewardship vs member
// access and which contracts a stewardship wire must pin — a positive identity test no generic layer can
// express. That stays here.
export {
  SESSION_WRAPPED_SIG_TYPE,
  wrapSessionSignature,
  parseSessionWrappedSignature,
  checkSessionWireShape,
  verifySessionWrappedSignature,
  sessionBodyHash,
  wireToDelegation as toDelegation,
} from '@agenticprimitives/a2a';
export type { DelegationWireV1 as IncomingDelegation } from '@agenticprimitives/a2a';
