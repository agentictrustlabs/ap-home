'use client';
// Developer tools → Evals → Acts (spec 420 — the act laboratory).
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { ActLaboratory } from '../../../../../src/components/portal/ActLaboratory';

export default function EvalsActsPage() {
  return (
    <SectionShell title="Acts" description="Did the Home reach the act that was asked for, under the domain's principles? Every Home Ask and every button is a case, judged on the act reached, per principle.">
      <ActLaboratory />
    </SectionShell>
  );
}
