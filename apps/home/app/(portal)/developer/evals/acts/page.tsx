'use client';
// Developer tools → Evals → Acts (spec 420 — the act laboratory).
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { HowToRead } from '../../../../../src/components/portal/HowToRead';
import { ActLaboratory } from '../../../../../src/components/portal/ActLaboratory';

export default function EvalsActsPage() {
  return (
    <SectionShell title="Acts" description="Did the Home reach the act that was asked for, under the domain's principles? Every Home Ask and every button is a case, judged on the act reached, per principle.">
      <HowToRead testId="evals-acts-how" lines={[
        ['What is measured', 'Every Home Ask and every button is a case with a known right act: which capability, which parties, what amount, whose authority. The case is judged on the act the run reached and its receipt — never on the writing.'],
        ['The domain\'s principles', 'The rules the domain holds ("assets live only in treasuries", "an act needs a mandate"). Each shows right / judged in the latest run: 3/3 means every case that exercises it held; a red count names the cases that broke it.'],
        ['The act sets', 'Groups of cases by area. Open a set to see each case, its latest verdict per variant, and what the reply was (parked for a signature, done, refused).'],
        ['Untested', 'A principle with no case yet is a hope, not a fact — it is listed so it is not mistaken for a pass.'],
      ]} />
      <ActLaboratory />
    </SectionShell>
  );
}
