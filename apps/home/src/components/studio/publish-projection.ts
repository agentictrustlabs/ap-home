'use client';
// The chain that writes a projection to its target, as one call.
//
// It was inline in ListingFlow, which is why the Naming page ended up with TWO writers for ONE record:
// the projection's own button (which sets the card-derived records — display name, A2A endpoint, card
// address and digest) and the name-record editor's Save (which sets the hand-written ones). Two buttons
// and two status lines for one on-chain record, and they could disagree on screen: "shows an older
// version of the card" beside "No changes".
//
// Extracting it lets one Save do both. The steps are unchanged — configure, preview, plan, request
// approval, approve, sign, execute — because they are how a projection is made accountable (spec 347 §6),
// not a sequence anyone set out to perform.
import type { Address } from '@agenticprimitives/types';
import {
  approveProjectionPublication,
  configureProjection,
  executePublicationPlan,
  planProjectionPublication,
  previewProjection,
  requestProjectionApproval,
  type DelegationWire,
  type StudioFamily,
} from '../../studio-client';
import type { SignHash } from '../../connect-client';

export interface PublishProjectionInput {
  family: StudioFamily;
  delegation: DelegationWire;
  sa: Address;
  cardResourceId: string;
  /** The RELEASED card the projection consumes — a projection never reads a draft. */
  releaseId: string;
  configuration?: Record<string, unknown>;
  signHashFor(): Promise<SignHash>;
  /** Progress in the user's words; the caller owns the phrasing. */
  onPhase?(phase: 'preparing' | 'custodian' | 'writing' | 'confirming'): void;
  onLosses?(losses: readonly unknown[]): void;
  newMutation(): { idempotencyKey: string; correlationId: string } | Record<string, unknown>;
}

export async function publishProjection(input: PublishProjectionInput): Promise<void> {
  input.onPhase?.('preparing');
  const cfg = await configureProjection(input.delegation, {
    family: input.family,
    ...(input.configuration ? { configuration: input.configuration as never } : {}),
    cardResourceId: input.cardResourceId,
    selectedReleaseId: input.releaseId,
  }, input.newMutation() as never);
  const id = cfg.instance.instanceId;

  const preview = await previewProjection(input.delegation, id);
  input.onLosses?.(preview.result.losses);

  const planned = await planProjectionPublication(input.delegation, id, input.newMutation() as never);
  await requestProjectionApproval(input.delegation, id, planned.plan.planId, input.newMutation() as never);
  const approved = await approveProjectionPublication(input.delegation, id, planned.plan.planId, input.newMutation() as never);

  input.onPhase?.('custodian');
  const signHash = await input.signHashFor();
  input.onPhase?.('writing');
  await executePublicationPlan(input.sa, signHash, input.delegation, id, planned, approved.approval.approvalId, input.newMutation() as never);
  input.onPhase?.('confirming');
}
