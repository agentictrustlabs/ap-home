'use client';
// Developer tools → Runtimes (spec 400 W1b). Pairing your own Claude Code / goose / Codex as a workspace member is a
// technical act; it lived on Friends, where it was the one thing on the page that was not about people.
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { RuntimePairingPanel } from '../../../../src/components/portal/RuntimePairingPanel';

export default function RuntimesPage() {
  return (
    <SectionShell
      title="Runtimes"
      description="Your own Claude Code, goose or Codex as a member of a workspace you steward — under grants you sign and can revoke."
    >
      <RuntimePairingPanel />
    </SectionShell>
  );
}
