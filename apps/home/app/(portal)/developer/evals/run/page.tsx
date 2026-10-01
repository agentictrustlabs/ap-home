'use client';
// Developer tools → Evals → Run a comparison (spec 415 A5 — the Lab's Run tab, as a page).
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { ComparisonRunner } from '../../../../../src/components/portal/ComparisonRunner';

export default function EvalsRunPage() {
  return (
    <SectionShell title="Run a comparison" description="Pick an organization you steward, upload a replay set and its gold (fixtures optional), build the arms — provider, who selects, who answers, who judges, the judge profile and mode — set split and repeats, and submit. Progress and scores appear here as the estate runs it.">
      <ComparisonRunner />
    </SectionShell>
  );
}
