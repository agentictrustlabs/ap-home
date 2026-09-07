'use client';
// Settings → Behaviour → Playbook (spec 348 §2.3): the ARCHETYPE the person's own agent runs under
// (spec 354 K3) — the compiled behaviour: which acts it knows how to do, the doctrine it answers under,
// what follows each act. Assigned at onboarding (`home/default-archetype.ts`) and re-assignable here,
// exactly as a treasury's or an organization's is on their surfaces. The write is the person's own act
// into their own vault, and it grants nothing — every act still waits on a mandate they sign.
//
// ONE playbook, ONE source. The free-text "assistant instructions" markdown that used to sit under this
// panel is gone: a person's agent answers messages and routed discussion questions under the compiled
// archetype (`internal.inbox.read` / `internal.consult.context` carry its instructions), so a second
// hand-typed playbook was a second behaviour source nothing verified and the digest never covered
// (spec 354 §1 — behaviour is generated from the domain author's SKILL.md contracts, never authored here).
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { BehaviourPlaybook } from '../../../src/components/portal/BehaviourPlaybook';
import { useSession } from '../../../src/context/session';

export default function PlaybookPage() {
  const { agentAddress, agentName } = useSession();
  return (
    <SectionShell title="Playbook">
      {agentAddress
        ? <BehaviourPlaybook agent={agentAddress} kind="person" name={agentName || undefined} />
        : <p className="manage-card-blurb">Sign in to see your agent’s playbook.</p>}
    </SectionShell>
  );
}
