'use client';
// Org → Invite member (spec 315 workspace action). PLACEHOLDER VIEW — the email-invite flow is a
// follow-up; this route exists so the topbar "Invite member" action lands somewhere real.
import { use } from 'react';
import { SectionShell } from '../../../../../src/components/portal/SectionShell';

export default function OrgInvitePage({ params }: { params: Promise<{ org: string }> }) {
  use(params); // resolve the route params promise; the invite flow (next) will use the org SA
  return (
    <SectionShell title="Invite a member">
      <div className="card" style={{ maxWidth: 560, padding: '1.4rem' }}>
        <p style={{ fontSize: '.9rem', margin: '0 0 .6rem' }}>
          Invite someone to this organization by <b>email</b> — they&rsquo;ll get a link that brings them
          here to join.
        </p>
        <input
          placeholder="name@example.org"
          disabled
          style={{ width: '100%', maxWidth: 340, marginBottom: '.7rem', opacity: 0.6 }}
        />
        <div>
          <button className="btn" disabled title="Coming next">Send invite link</button>
        </div>
        <p style={{ fontSize: '.78rem', opacity: 0.6, marginTop: '.9rem' }}>
          The invite flow isn&rsquo;t wired up yet — this is the entry point; we&rsquo;ll build the
          email-link sending next.
        </p>
      </div>
    </SectionShell>
  );
}
