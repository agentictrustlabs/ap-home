'use client';
// Developer tools → Evals → Live gates (spec 392 — the nightly gates, night by night).
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { EvalsDashboard } from '../../../../../src/components/portal/EvalsDashboard';

export default function EvalsGatesPage() {
  return (
    <SectionShell title="Live gates" description="What the nightly live gates said, night by night. Each gate is a script against the running estate with a twin that must fail; recurring failures first.">
      <EvalsDashboard />
    </SectionShell>
  );
}
