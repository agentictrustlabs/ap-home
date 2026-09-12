'use client';
// ROUTINES — spec 398 G3: a versioned skill + a trigger + fresh authority, with its run history (spec 375 as a product).
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { RoutinesView } from '../../../src/components/portal/RoutinesView';
export default function RoutinesPage() { return <SectionShell title="Routines"><RoutinesView scope={{ kind: 'person' }} /></SectionShell>; }
