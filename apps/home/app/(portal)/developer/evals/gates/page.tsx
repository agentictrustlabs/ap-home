'use client';
// Developer tools → Evals → Live gates (spec 392 — the nightly gates, night by night).
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { HowToRead } from '../../../../../src/components/portal/HowToRead';
import { EvalsDashboard } from '../../../../../src/components/portal/EvalsDashboard';

export default function EvalsGatesPage() {
  return (
    <SectionShell title="Live gates" description="What the nightly live gates said, night by night. Each gate is a script against the running estate with a twin that must fail; recurring failures first.">
      <HowToRead testId="evals-gates-how" lines={[
        ['What a live gate is', 'A script that runs against the real estate every night: it signs in as a demo person, asks or acts, and checks what happened — with a twin that must fail (a stranger refused, a payment over the cap parked).'],
        ['Recurring failures', 'The same gate failing for the same reason on two or more nights. These come first because they are the ones to fix; a failure seen once is listed below by gate.'],
        ['Truth cases', 'Questions with a known true answer put to the agent (the incidents that once produced a plausible falsehood). "holds" means the answer was true.'],
        ['The gates, by night', 'One row per gate, one column per night. The chip is the failure class when it failed. "advisory" gates report but do not fail the night.'],
        ['Failure classes', 'A failure is classified by a fixed table over the script\'s own last lines, never by a model. "unclassified" is itself a finding.'],
      ]} />
      <EvalsDashboard />
    </SectionShell>
  );
}
