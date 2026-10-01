'use client';
// Developer tools → Evals → Techniques (spec 418 §5/§8 — the technique ledger and the adoption rule).
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { TechniqueLedger } from '../../../../../src/components/portal/TechniqueLedger';

export default function EvalsTechniquesPage() {
  return (
    <SectionShell title="Techniques" description="The technique ledger. A default changes only on a paired, pre-registered comparison with no regression on the panel.">
      <TechniqueLedger />
    </SectionShell>
  );
}
