'use client';
// A service agent's routines (spec 398 G3 over spec 375).
import { use } from 'react';
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { RoutinesView } from '../../../../../src/components/portal/RoutinesView';
export default function PersonaRoutinesPage({ params }: { params: Promise<{ agent: string }> }) { const { agent } = use(params); return <SectionShell title="Routines"><RoutinesView scope={{ kind: 'persona', agent }} /></SectionShell>; }
