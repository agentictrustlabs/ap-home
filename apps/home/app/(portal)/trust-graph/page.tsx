'use client';
// Trust graph (ported from the impact app) — the member's relationships drawn as a web of
// provenance-grounded trust. LIVE-only in this port: the graph is assembled from the session
// profile (the person SA) + the managed-agent tree (each org you steward / belong to, MAM-D7)
// — impact's seed-backed preview graphs were intentionally NOT ported. Unconnected visitors
// get a friendly "connect first" state instead of a mock.
import Link from 'next/link';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { ClassExplainer, GraphCard, useLivePerson } from '../../../src/components/graph/TrustGraph';

export default function TrustGraphPage() {
  const { phase } = useSession();
  const { live, loaded } = useLivePerson();

  // Not connected → no mock graph (the impact seed preview was dropped): invite them in.
  if (phase === 'anon') {
    return (
      <SectionShell title="Trust graph">
        <div className="manage-card" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
          <p style={{ margin: '0 auto 1rem', maxWidth: 460, fontSize: '.9rem', color: 'var(--color-text-muted)' }}>
            Your trust graph is drawn from your <strong>own</strong> agent relationships — connect
            to see you (the custodian), your person agent, and every organization you steward.
          </p>
          <Link href="/" className="btn-primary" style={{ width: 'auto', display: 'inline-block' }}>Connect to see your trust graph</Link>
        </div>
      </SectionShell>
    );
  }

  // Session restoring, or the managed-agent vault read still in flight — never flash the empty state.
  if (!live || !loaded) {
    return (
      <SectionShell title="Trust graph">
        <p className="manage-card-blurb">Loading your relationships…</p>
      </SectionShell>
    );
  }

  // Connected but no org relationships yet — it's just the custodian + person SA.
  if (live.orgs.length === 0) {
    return (
      <SectionShell title="Trust graph">
        <div className="manage-card" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
          <div style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '.4rem' }}>It&apos;s just you and your agent so far</div>
          <p style={{ maxWidth: 460, margin: '0 auto 1.2rem', fontSize: '.9rem', color: 'var(--color-text-muted)' }}>
            You hold the keys to <strong>{live.agentName}</strong> (a control relationship).
            Your trust graph grows with <strong>authority between smart agents</strong> — create an
            organization to draw your first stewardship edge.
          </p>
          <Link href="/organizations" className="btn-primary" style={{ width: 'auto', display: 'inline-block' }}>Create an organization</Link>
        </div>
      </SectionShell>
    );
  }

  return (
    <SectionShell title="Trust graph">
      <ClassExplainer />
      <GraphCard live={live} />
      <p style={{ fontSize: '.78rem', marginTop: '.9rem', color: 'var(--color-text-faint)' }}>
        Tip: click any node to inspect it; drag to rearrange. Your person→org edges are live from
        your managed-agent tree; org-internal trust dimensions bind from the org trust agent in a
        later phase.
      </p>
    </SectionShell>
  );
}
