'use client';
// A persona's ASK (spec 348 §2.3) — the assistant that answers when THIS name is addressed. It is the
// agent-scoped panel, not the person's own: a persona has its own playbook and its own vault, which is the
// whole reason a character in a game or a name on a trail can answer as itself.
import { use } from 'react';
import { OrgAgentSection } from '../../../../../src/components/portal/settings/org-agent';

export default function PersonaAskPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <OrgAgentSection orgSa={agent} only="ask" />;
}
