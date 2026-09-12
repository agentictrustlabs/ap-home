'use client';
// The organization's routines (spec 398 G3 over spec 375).
import { use } from 'react';
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { RoutinesView } from '../../../../../src/components/portal/RoutinesView';
export default function OrgRoutinesPage({ params }: { params: Promise<{ org: string }> }) { const { org } = use(params); return <SectionShell title="Routines"><RoutinesView scope={{ kind: 'org', org }} /></SectionShell>; }
