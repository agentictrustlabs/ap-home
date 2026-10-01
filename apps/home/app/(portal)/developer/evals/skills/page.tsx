'use client';
// Developer tools → Evals → Skill selection (spec 415 §5b — the Lab). A "how to read" panel first; the report below it.
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { SkillAssessmentLab } from '../../../../../src/components/portal/SkillAssessmentLab';
import { HowToRead } from '../../../../../src/components/portal/HowToRead';

export default function EvalsSkillsPage() {
  return (
    <SectionShell title="Skill selection" description="Did the agent choose the right skill for what people asked?">
      <HowToRead testId="evals-skills-how" lines={[
        ['What is measured', 'Each test sentence names the skill that should handle it. The agent runs the sentence for real and records which skill it used; the two are compared. The answer\'s wording is never graded here — only the choice.'],
        ['Right skill', 'Of the sentences a skill should handle, how many picked that skill. The headline is pooled over the latest experiment on each test set.'],
        ['Declined when it should', 'Some sentences fit no skill on purpose. This is how often the agent said so instead of forcing one. Below 95% is flagged.'],
        ['What to change', 'Recommendations come from declared rules over the results and name the test sentences they rest on. "Act on" is the ones worth a change now.'],
        ['Experiments and approaches', 'An experiment is one run of a test set; an approach is how the skill was selected (the model, a rule, a cheaper selector). Compare approaches on the same set, never across sets.'],
      ]} />
      <SkillAssessmentLab />
    </SectionShell>
  );
}
