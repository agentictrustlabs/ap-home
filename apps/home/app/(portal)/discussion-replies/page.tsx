'use client';
// Settings → Behaviour → Discussion replies (spec 348 §2.3) — how this agent behaves in discussions.
// NOT the top band's Discussions, which is where you take part; this edits the replies.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { AgentTab } from '../../../src/components/portal/agent/AgentTab';

export default function DiscussionRepliesPage() {
  return <SectionShell title="Discussion replies"><AgentTab only="discussion" /></SectionShell>;
}
