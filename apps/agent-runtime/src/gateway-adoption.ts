// THE ADOPTION LEDGER — which of this runtime's ops serves from which plane (ADR-0060; ADR-0055 amendment).
//
// The MECHANISM — the rungs (`off → shadow → serving`), the rung rule, divergence comparison, race
// classification and sampling — is `@agenticprimitives/fabric`'s (`adoption.ts`, promoted in spec 399 W0).
// What stays here is the DATA: which op sits on which rung, what its move puts at risk, and why. An op absent
// from this table is `off`: adoption is opt-in, because the failure mode of opt-out is an op that moved
// because nobody remembered to stop it.
import { adoptionStage as stageFromLedger, type AdoptionLedger, type AdoptionStage } from '@agenticprimitives/fabric';
export type { AdoptionConcern, AdoptionEntry, AdoptionStage, Divergence } from '@agenticprimitives/fabric';

export const GATEWAY_ADOPTION: AdoptionLedger = {
  'inbox.get': {
    stage: 'shadow',
    // Auth: the gateway re-verifies the grant and caches the verdict, where InteractionsDO verifies per
    // call. Projection + data-shape: the gateway returns the co-resident vault tool's envelope, and the
    // inbox document's shape is what the Home replays on every poll. Ordering is NOT in play — this reads
    // one document, it does not fold the exchange stream.
    concerns: ['auth', 'projection', 'data-shape'],
    // NONE, and this is a finding rather than a default. Both planes read the SAME stored vault document
    // and `inboxRevision` is a pure content hash — no clock, no counter, nothing computed per read. So the
    // audit's expected noise source (timestamps, revision counters at different instants) does not exist
    // here. The real one is TEMPORAL: the serving read and the shadow read happen microseconds apart, and
    // a delivery landing in between changes the document legitimately. That is a race, not a volatile
    // field, and a field mask would not have caught it — `raced` classification does.
    volatileFields: [],
    note:
      'first op on the ladder; the exchange stream is untouched, so no ordering claim is being made. ' +
      'BEFORE PROMOTING (audit G-5): the auth concern here is bounded verdict reuse — the gateway caches ' +
      'verdict (A) for VERDICT_TTL_MS (60s) where InteractionsDO verifies per call, so a revoked ' +
      'delegation can pass admission for up to that window. demo-mcp re-enforces per record and is the ' +
      'authority, which bounds the exposure to admission only — but it is a real behaviour change and it ' +
      'must be stated, not discovered. ' +
      'NOISE MODEL (audit G-4): no volatile fields — both planes read the same stored document and ' +
      'inboxRevision is a pure content hash. The only benign difference is a RACE (a delivery landing ' +
      'between the two reads), which the re-read classifies as `raced` rather than leaving it to look ' +
      'like a defect.',
  },
};

/** The stage this op runs at IN THIS DEPLOYMENT: this runtime's ledger, the deployment's `GATEWAY_SHADOW`. */
export function gatewayStage(op: string, env?: { GATEWAY_SHADOW?: string }): AdoptionStage {
  return stageFromLedger(GATEWAY_ADOPTION, op, env);
}
