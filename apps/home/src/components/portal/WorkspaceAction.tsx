'use client';
// The topbar's action slot, right of the workspace switcher (spec 315).
//
// As of 2026-10-02 it is intentionally EMPTY. "Add organization" moved to the Stewardship → Organizations page
// (`/agents`), where it is that page's prominent primary action (the ManagedAgents "Add an organization" card),
// and org invites live on the organization's Members page. The topbar stays a switch-and-act bar, uncrowded and
// not widened by a create button. Kept as a component so the topbar layout slot stays stable for callers.
export function WorkspaceAction() {
  return null;
}
