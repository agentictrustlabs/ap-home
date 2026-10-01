'use client';
// Developer tools → Evals → Run a comparison (spec 415 A5 — the Lab's Run tab, as a page).
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { HowToRead } from '../../../../../src/components/portal/HowToRead';
import { ComparisonRunner } from '../../../../../src/components/portal/ComparisonRunner';

export default function EvalsRunPage() {
  return (
    <SectionShell title="Run a comparison" description="Pick an organization you steward, upload a replay set and its gold (fixtures optional), build the arms — provider, who selects, who answers, who judges, the judge profile and mode — set split and repeats, and submit. Progress and scores appear here as the estate runs it.">
      <HowToRead testId="evals-run-how" lines={[
        ['What you are starting', 'A comparison runs a test set through the organization\'s real agent once per arm, then scores every arm on the same cases. It costs model calls; the estate runs it one case at a time and this page polls.'],
        ['The files', 'The replay set is the test sentences (.replay.json); the gold is the answer key (.gold.json); fixtures (optional) are the records the cases assume exist.'],
        ['Arms', 'Each arm is one way of running: which provider selects the skill, which answers, which judges, the judge\'s profile and mode, and the selection arm. A row with nothing chosen is the live default.'],
        ['Split and repeats', '"held-out" scores only the cases kept back from development; "all" uses every case. Repeats run each case more than once to see how stable the result is.'],
        ['Reading the scores', 'Micro and macro accuracy (per case, per skill), hold (declined when it should), purity, and the gate; then every pairwise comparison with its confounds named — what differs between two arms besides the thing you changed.'],
      ]} />
      <ComparisonRunner />
    </SectionShell>
  );
}
