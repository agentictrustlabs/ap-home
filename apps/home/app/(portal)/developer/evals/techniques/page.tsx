'use client';
// Developer tools → Evals → Techniques (spec 418 §5/§8 — the technique ledger and the adoption rule).
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { HowToRead } from '../../../../../src/components/portal/HowToRead';
import { TechniqueLedger } from '../../../../../src/components/portal/TechniqueLedger';

export default function EvalsTechniquesPage() {
  return (
    <SectionShell title="Techniques" description="The technique ledger. A default changes only on a paired, pre-registered comparison with no regression on the panel.">
      <HowToRead testId="evals-techniques-how" lines={[
        ['What is measured', 'A technique is one change to how the agent works (a different selector, a retrieval step, a judge mode). It is measured against the baseline on the SAME cases, paired: did this case flip from wrong to right, or right to wrong?'],
        ['The verdict words', '"better and cheaper" through "worse" combine quality and cost. "too few cases" means the comparison cannot tell yet. "planned" means the A/B is written but has not run.'],
        ['fixed / broken', 'How many cases the technique fixed and how many it broke. p below 0.05 means a difference that size is unlikely to be chance.'],
        ['tokens and time to pick', 'The cost of choosing the skill, as a percentage change against the baseline; "whole ask" is the full run.'],
        ['The adoption rule', 'A default changes only on a pre-registered, paired comparison with no regression on the panel. A decision line under a technique records when that happened.'],
      ]} />
      <TechniqueLedger />
    </SectionShell>
  );
}
