'use client';
// "Who is here" — the roster of an organization's or workspace's members (spec 348 §2.1).
//
// This is NOT the membership management surface. Settings → Membership is where a steward decides who
// gets in and who is removed; this is the participation view: the people you are working with, and a way
// to reach them. They were one page, which meant looking up a colleague put you on a screen full of
// pending applications and invite controls.
//
// The roster is the UNION of both projections of membership (`fetchRoster`): a member's own signed
// directory listing, and the steward's received-delegations index for those who joined by invite and
// never published one. Reading either alone hides real members — that mistake is why Discussions used to
// report "Participants · 0" beside five join messages.
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import { SectionShell } from './SectionShell';
import { fetchRoster, type RosterMember } from '../../lib/recipient-directory';
import { AddressChip } from '../shared/AddressChip';
import { setAskSelection } from '../../home/ask-selection';
import { rosterRows, type RosterRow } from '../../home/roster-contract';
import { fetchWorkList } from '../../lib/work-client';
import { List, KeyValue, Empty, ErrorNote, Meta, LinkButton } from '../../ui';

export function MemberRoster({ agent, title = 'Members' }: { agent: string; title?: string }) {
  const { session, agentAddress } = useSession();
  const [members, setMembers] = useState<RosterMember[] | null>(null);
  // Spec 398 §4.5 — active work per participant: items where they are an executor, from the organization's work list.
  const [executors, setExecutors] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);
  // Spec 361 I6 — the member the person has selected, handed to the Ask as context.
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session?.token) return;
    setError(null);
    try {
      setMembers(await fetchRoster(session.token, agent));
      // §12 visibility: the work list carries the CALLER's own allocations and commitments, not everyone's — so the
      // count is yours; another member's active work reads "not visible to you" rather than a false zero (398 §6.3).
      const w = await fetchWorkList(session.token, agent).catch(() => null);
      const counts = new Map<string, number>();
      const me = (agentAddress ?? '').toLowerCase();
      if (me) counts.set(me, (w?.mine?.allocations?.length ?? 0) + (w?.mine?.commitments ?? []).filter((c) => c.status === 'active').length);
      setExecutors(counts);
    } catch (e) {
      // A directory refusal (403 — not a member) is a real answer and is named, never papered over.
      setError(e instanceof Error ? e.message : String(e));
      setMembers([]);
    }
  }, [session?.token, agent, agentAddress]);
  useEffect(() => { void load(); }, [load]);

  if (!session) return <SectionShell title={title}><Empty>Not signed in.</Empty></SectionShell>;

  const rows = members ? rosterRows({ members, executors }) : [];
  return (
    <SectionShell title={title} description={<>The people in this workspace and how to reach them. Who belongs is decided under Settings → Membership.</>}>
      {error && <ErrorNote>{error}</ErrorNote>}
      {members === null ? (
        <Meta>Reading the roster…</Meta>
      ) : members.length === 0 ? (
        <Empty title="No members yet">Invite someone under Settings → Membership; they appear here once they accept.</Empty>
      ) : (
        <List testId="roster">
          {rows.map((m: RosterRow) => {
            const you = !!agentAddress && m.address.toLowerCase() === agentAddress.toLowerCase();
            const picked = selected === m.address.toLowerCase();
            const facets = [m.kin, m.role && m.role !== 'member' ? m.role : null].filter(Boolean).join(' · ');
            return (
              <div
                key={m.address}
                className="ui-row"
                // Spec 361 I6 — selecting a member is context the Ask can use ("invite her", "message him"):
                // the reference reaches the agent as validated context, never as words in a prompt.
                role="button" tabIndex={0} aria-pressed={picked}
                onClick={() => { const next = picked ? null : m.address.toLowerCase(); setSelected(next); setAskSelection(next ? { entity: next as `0x${string}`, kind: 'person', label: m.displayName } : null); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (e.currentTarget as HTMLDivElement).click(); } }}
                style={{ cursor: 'pointer', alignItems: 'flex-start', ...(picked ? { background: 'var(--color-surface-raised)', boxShadow: 'inset 3px 0 0 var(--color-amber-500)' } : {}) }}
                data-testid={`member-${m.address}`}
              >
                <div className="ui-row-main">
                  <div className="ui-row-title" style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    {m.displayName}{you && <span className="ui-micro">you</span>}
                    {m.publicName && <span className="ui-meta">{m.publicName}</span>}
                    {facets && <span className="ui-meta" data-testid={`member-facets-${m.address}`}>{facets}</span>}
                  </div>
                  <div style={{ margin: '2px 0 6px' }}><AddressChip address={m.address as `0x${string}`} size="sm" /></div>
                  {/* Spec 398 §4.5 — the roster contract: type · sponsor · responsibility · permissions · active work. */}
                  <div data-testid={`member-contract-${m.address}`}>
                    <KeyValue rows={[
                      ['type', m.type, { absent: m.type === 'unknown' }],
                      ['sponsor', m.sponsor],
                      ['responsibility', m.responsibility ?? 'none assigned', { absent: !m.responsibility }],
                      ['permissions', m.permissions],
                      ['active work', you ? (m.activeWork === 0 ? 'none' : `${m.activeWork} item${m.activeWork === 1 ? '' : 's'}`) : 'not visible to you — their own view', { absent: !you }],
                    ]} />
                  </div>
                </div>
                {!you && (
                  <div className="ui-row-side">
                    <LinkButton size="sm" href={`/messages?to=${m.address}`} onClick={(e) => e.stopPropagation()}>Message</LinkButton>
                  </div>
                )}
              </div>
            );
          })}
        </List>
      )}
    </SectionShell>
  );
}
