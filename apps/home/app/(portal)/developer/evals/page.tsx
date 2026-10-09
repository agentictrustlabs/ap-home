'use client';
// Developer tools → Evals → Overview (owner, 2026-10-01: "Evals is not clear at all"). Before any number: what an eval is
// here, and one row per page saying the question it answers, where its numbers come from, and how to read them. Old
// `?tab=` links are sent to the page that tab became.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { DatabaseIcon, BotIcon, ShieldIcon, CodeIcon, CheckIcon } from '../../../../src/components/shared/Icons';
import { List, Row } from '../../../../src/ui';
import { Panel } from '../../../../src/ui/panel';

const TAB_PAGES: Record<string, string> = { skills: '/developer/evals/skills', acts: '/developer/evals/acts', techniques: '/developer/evals/techniques', gates: '/developer/evals/gates', run: '/developer/evals/run' };

export default function EvalsOverviewPage() {
  const router = useRouter();
  // A `?tab=` link is sent to the page that tab became — WITH the rest of its query. The Lab's link names the agent, the
  // set, the repeats and the arms; dropping them here is why a click from the skills app opened the Run page on its
  // defaults (scripture-294b.org and the CIL set) instead of the comparison it named.
  useEffect(() => { try {
    const u = new URL(window.location.href); const t = u.searchParams.get('tab');
    if (t && TAB_PAGES[t]) { u.searchParams.delete('tab'); const q = u.searchParams.toString(); router.replace(`${TAB_PAGES[t]!}${q ? `?${q}` : ''}`); }
  } catch { /* no URL */ } }, [router]);
  return (
    <SectionShell title="Evals" description="Evidence of what the agent actually did, so a change is adopted on a measurement and never on a feeling.">
      <Panel title="What an eval is here" icon={<CheckIcon size={18} />} state="ready" testId="evals-overview-what">
        <div className="ui-panel-body">
          <p style={{ margin: '0 0 var(--sp-2)' }}><b>An eval is a set of test sentences with a known right answer, run through the real agent, and scored by a fixed rule.</b> "Pay nathan.treasury 5 USDC" should pick the payment skill and stop for a signature; "what invitations do I have" should pick the invitations read and answer from the record. The score is how often it did.</p>
          <p style={{ margin: '0 0 var(--sp-2)' }}><b>Nothing on these pages is a model's opinion of itself.</b> The sentences are authored test cases, never a person's words. The judge is a rule or a separate model with a declared profile, and every number says which cases it rests on.</p>
          <p style={{ margin: 0 }}><b>The rule for changing a default:</b> only on a paired comparison, pre-registered, with no regression on the panel. That is why Techniques exists.</p>
        </div>
      </Panel>
      <Panel title="The five pages" icon={<DatabaseIcon size={18} />} state="ready" testId="evals-overview-pages">
        <List>
          <Row href="/developer/evals/skills" title="Skill selection" meta="Question: for each test sentence, did the agent pick the right skill, and did it decline when no skill fits? Numbers from the latest experiment on each test set. Read: 'right skill' and 'declined when it should' as fractions; 'What to change' lists the rules that fired." side={<DatabaseIcon size={16} />} />
          <Row href="/developer/evals/acts" title="Acts" meta="Question: did the Home reach the act that was asked for — the right capability, parties, amount, and whose authority — under the domain's principles? Each principle shows right / judged. Read: a principle that is not green names which cases broke it." side={<BotIcon size={16} />} />
          <Row href="/developer/evals/techniques" title="Techniques" meta="Question: when we tried a technique, was it better, the same, or worse than the baseline on the same cases, and what did it cost? Read: the verdict words (better and cheaper … worse); 'fixed / broken' counts cases that flipped; p below 0.05 means the change is unlikely to be chance." side={<CheckIcon size={16} />} />
          <Row href="/developer/evals/gates" title="Live gates" meta="Question: against the running estate, did each scripted check pass last night, and which failures keep coming back? Read: recurring failures first (the ones to fix), then every gate by night; 'advisory' gates do not fail the night." side={<ShieldIcon size={16} />} />
          <Row href="/developer/evals/run" title="Run a comparison" meta="Start one yourself: pick an organization you steward, upload a test set and its answer key, choose the arms to compare, and watch it run. The scores arrive here when it finishes." side={<CodeIcon size={16} />} />
        </List>
      </Panel>
    </SectionShell>
  );
}
