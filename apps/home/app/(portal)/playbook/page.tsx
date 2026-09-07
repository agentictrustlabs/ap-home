'use client';
// Settings → Behaviour → Playbook (spec 348 §2.3). TWO things, in this order:
//
//  1. The ARCHETYPE the person's own agent runs under (spec 354 K3) — the compiled behaviour: which acts it
//     knows how to do, the doctrine it answers under, what follows each act. Assigned at onboarding
//     (`home/default-archetype.ts`) and re-assignable here, exactly as a treasury's or an organization's
//     is on their surfaces; until 2026-09-07 a person could see the playbook of every agent they
//     stewarded and never their own. The write is the person's own act into their own vault, and it
//     grants nothing — every act still waits on a mandate they sign.
//  2. The free-text SKILL.md that shapes the auto-reply assistant (`apguide:AgentSkillPackage`).
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { AgentTab } from '../../../src/components/portal/agent/AgentTab';
import { BehaviourPlaybook } from '../../../src/components/portal/BehaviourPlaybook';
import { useSession } from '../../../src/context/session';

export default function PlaybookPage() {
  const { agentAddress, agentName } = useSession();
  return (
    <SectionShell title="Playbook">
      {agentAddress && <BehaviourPlaybook agent={agentAddress} kind="person" name={agentName || undefined} />}
      <AgentTab only="playbook" />
    </SectionShell>
  );
}
