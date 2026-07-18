'use client';
// Manage → Agent (spec 328 UX v2) — the person's agent config in the Manage band: "Message bot"
// (auto-reply on/off + the delivery status it depends on) and "SKILL.md" (playbook docs) as
// horizontal sub-tabs. Replaces the Messages ⚙ settings dialog (0c07dde6).
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { AgentTab } from '../../../src/components/portal/agent/AgentTab';

export default function AgentPage() {
  return (
    <SectionShell title="Agent">
      <AgentTab />
    </SectionShell>
  );
}
