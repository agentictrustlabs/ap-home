'use client';
// `/skills` is the old address of this page. The word now means a SKILL.md playbook and nothing else
// (ADR-0051); what lives here is the agent's CAPABILITIES. Redirect rather than delete: the path is in
// people's history and in older docs, and a 404 would read as the feature being gone.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function SkillsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/capabilities'); }, [router]);
  return null;
}
