'use client';
// "Your apps" — the member's own OIDC client registrations.
//
// It sits under Manage, next to Connected Apps, because the two are the same question from
// opposite sides: Connected is "which apps may act for me", this is "which apps may ask people
// to sign in". Both are the member's to answer, which is why neither is a deployment setting.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { DeveloperApps } from '../../../src/components/portal/DeveloperApps';

export default function DeveloperPage() {
  return (
    <SectionShell
      title="Your apps"
      description="Register an app you're building so it can send people to this Home to sign in."
    >
      <p style={{ margin: '0 0 var(--sp-4)', fontSize: 'var(--fs-sm)' }}><a href="/developer/evals">Evals →</a> what the live gates and the truth cases said, night by night · <a href="/llms.txt">/llms.txt</a> — the coding agent&rsquo;s entrance to this estate.</p>
      <DeveloperApps />
    </SectionShell>
  );
}
