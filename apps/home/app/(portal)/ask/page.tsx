'use client';
// Settings → Behaviour → Ask (spec 348 §2.3) — the assistant that answers when this agent is addressed.
// Was the `Assistant` sub-tab of the Agent page.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { AgentTab } from '../../../src/components/portal/agent/AgentTab';
import { AgentPreferencesPanel } from '../../../src/components/portal/AgentPreferencesPanel';

export default function AskPage() {
  return (
    <SectionShell title="Ask">
      {/* Spec 403 W2/W4 — the person's own preferences: how her agent reaches her and how it answers (the person's page). */}
      <AgentPreferencesPanel />
      <AgentTab only="ask" />
    </SectionShell>
  );
}
