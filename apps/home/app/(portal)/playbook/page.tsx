'use client';
// Settings → Behaviour → Playbook (spec 348 §2.3) — `apguide:AgentSkillPackage`, the guide that shapes
// every reply. Was the `Playbook` sub-tab of the Agent page.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { AgentTab } from '../../../src/components/portal/agent/AgentTab';

export default function PlaybookPage() {
  return <SectionShell title="Playbook"><AgentTab only="playbook" /></SectionShell>;
}
