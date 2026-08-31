'use client';
// Settings → Behaviour → Ask (spec 348 §2.3) — the assistant that answers when this agent is addressed.
// Was the `Assistant` sub-tab of the Agent page.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { AgentTab } from '../../../src/components/portal/agent/AgentTab';

export default function AskPage() {
  return <SectionShell title="Ask"><AgentTab only="ask" /></SectionShell>;
}
