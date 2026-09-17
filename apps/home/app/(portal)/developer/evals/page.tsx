'use client';
// EVALS — spec 398 §10 / the gap analysis P1.3: the nightly ledger as a dashboard, the recurring-failure view as a screen,
// and the latest `ap eval` run. Everything here is data folded at build time by `scripts/build-evals-dashboard.mts`
// (deterministic; the failure classes are the trend script's) — the screen renders; it judges nothing.
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { EvalsDashboard } from '../../../../src/components/portal/EvalsDashboard';

export default function EvalsPage() {
  return (
    <SectionShell title="Evals" description="What the live gates and the truth cases said, night by night — evidence, never a claim. Recurring failures first.">
      <EvalsDashboard />
    </SectionShell>
  );
}
