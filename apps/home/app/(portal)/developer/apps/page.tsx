'use client';
// Developer tools → Your apps — the member's own OIDC client registrations (moved from /developer when Developer
// tools became a pane, 2026-10-01). Connected is "which apps may act for me"; this is "which apps may ask people to
// sign in". Both are the member's to answer, which is why neither is a deployment setting.
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { DeveloperApps } from '../../../../src/components/portal/DeveloperApps';

export default function DeveloperAppsPage() {
  return (
    <SectionShell title="Your apps" description="Register an app you're building so it can send people to this Home to sign in.">
      <DeveloperApps />
    </SectionShell>
  );
}
