'use client';
// Connected → Assistants (spec 397 W4 / 422 §8). The assistants she let put questions to her agent AS HER — Claude
// through the Home MCP above all. They can ask; they can never sign. Revoking is on chain and final until she says yes again.
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { AppGrantsPanel } from '../../../../src/components/portal/AppGrantsPanel';
import { Note } from '../../../../src/ui';

export default function ConnectedAssistantsPage() {
  return (
    <SectionShell title="Assistants" description="Assistants you let put questions to your agent as you — and the button that stops each one.">
      <Note>An assistant you connected (Claude, for one) may <b>ask your agent questions as you</b>: your records, your organizations, your playbook, in your agent's own words with its evidence. It can never sign: anything that would change something still comes to this Home for your signature. Stopping an assistant is final until you say yes again — its next question is refused at your agent.</Note>
      <AppGrantsPanel showEmpty />
    </SectionShell>
  );
}
