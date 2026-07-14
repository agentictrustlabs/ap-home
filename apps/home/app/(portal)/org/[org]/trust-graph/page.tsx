'use client';
// Org-scoped trust graph (spec 315 workspace routing) — the same LIVE person graph, centered
// on THIS organization: custodian → person SA → the URL's org (focused), with any sibling
// orgs kept for context but dimmed. Impact's seed-backed org builder (members / service
// agents / partner assertions) was intentionally NOT ported — those edges bind live in a
// later phase; today the org view is the person graph seen from the org's seat.
import { use } from 'react';
import { useSession } from '../../../../../src/context/session';
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { ClassExplainer, GraphCard, useLivePerson } from '../../../../../src/components/graph/TrustGraph';

const lc = (s: string) => s.toLowerCase();

export default function OrgTrustGraphPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  const { session } = useSession();
  const { live, loaded } = useLivePerson();

  if (!session) return <SectionShell title="Trust graph"><p>Not signed in.</p></SectionShell>;
  if (!live || !loaded) {
    return (
      <SectionShell title="Trust graph">
        <p className="manage-card-blurb">Loading your relationships…</p>
      </SectionShell>
    );
  }

  const orgRel = live.orgs.find((o) => lc(o.agent) === lc(org));
  if (!orgRel) {
    return (
      <SectionShell title="Trust graph">
        <p className="manage-card-blurb">
          You don&apos;t hold a relationship with an organization at this address. Pick one from the
          workspace switcher.
        </p>
      </SectionShell>
    );
  }

  return (
    <SectionShell title={`${orgRel.name ?? 'Organization'} — trust graph`}>
      <ClassExplainer />
      <GraphCard live={live} focusOrg={org} />
      <p style={{ fontSize: '.78rem', marginTop: '.9rem', color: 'var(--color-text-faint)' }}>
        Centered on <strong>{orgRel.name ?? org}</strong> — your other organizations are dimmed for
        context. Org-internal edges (members, service agents, partner assertions) bind live from
        the org trust agent in a later phase.
      </p>
    </SectionShell>
  );
}
