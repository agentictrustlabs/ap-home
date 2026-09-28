'use client';
// EVALS — spec 398 §10 / the gap analysis P1.3: the nightly ledger as a dashboard, the recurring-failure view as a screen,
// and the latest `ap eval` run. Spec 415 §5b — and the LAB: what the skill assessment tested, whether each intent got the
// right skill, how each skill fares, and what to change. Everything here is data folded at build time
// (`scripts/build-evals-dashboard.mts`, deterministic) — the screen renders; it judges nothing.
import { useEffect, useState } from 'react';
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { EvalsDashboard } from '../../../../src/components/portal/EvalsDashboard';
import { SkillAssessmentLab } from '../../../../src/components/portal/SkillAssessmentLab';
import { TechniqueLedger } from '../../../../src/components/portal/TechniqueLedger';
import { Tabs } from '../../../../src/ui';

export default function EvalsPage() {
  const [tab, setTab] = useState<'skills' | 'techniques' | 'gates'>('skills');
  // `?tab=gates` (the nightly links here) — read after mount so the server and the first client render agree.
  useEffect(() => { try { const t = new URL(window.location.href).searchParams.get('tab'); if (t === 'gates' || t === 'techniques') setTab(t); } catch { /* no URL */ } }, []);
  return (
    <SectionShell title="Evals" description="Skill assessment — are the right skills chosen for what people ask, and what to change — and the live gates, night by night. Evidence, never a claim.">
      <Tabs label="evals" value={tab} onChange={setTab} items={[{ id: 'skills', label: 'Skill selection (playbooks)' }, { id: 'techniques', label: 'Techniques' }, { id: 'gates', label: 'Live gates' }]} />
      {tab === 'skills' ? <SkillAssessmentLab /> : tab === 'techniques' ? <TechniqueLedger /> : <EvalsDashboard />}
    </SectionShell>
  );
}
