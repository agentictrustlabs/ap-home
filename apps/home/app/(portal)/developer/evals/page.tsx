'use client';
// Developer tools → Evals → Skill selection. The five evals surfaces were tabs on one page; each is a page now (owner,
// 2026-10-01), so a link names one of them. Old links carried `?tab=`; they are sent to the page that tab became.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { SkillAssessmentLab } from '../../../../src/components/portal/SkillAssessmentLab';

const TAB_PAGES: Record<string, string> = { acts: '/developer/evals/acts', techniques: '/developer/evals/techniques', gates: '/developer/evals/gates', run: '/developer/evals/run' };

export default function EvalsSkillsPage() {
  const router = useRouter();
  useEffect(() => { try { const t = new URL(window.location.href).searchParams.get('tab'); if (t && TAB_PAGES[t]) router.replace(TAB_PAGES[t]!); } catch { /* no URL */ } }, [router]);
  return (
    <SectionShell title="Skill selection" description="Are the right skills chosen for what people ask? Per intent: expected versus chosen; per skill: its results; comparisons between playbooks. Evidence, never a claim.">
      <SkillAssessmentLab />
    </SectionShell>
  );
}
