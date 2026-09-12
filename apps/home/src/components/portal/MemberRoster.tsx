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
import { cardSty, mutedText, errorText } from './theme';
import { setAskSelection } from '../../home/ask-selection';
import { rosterRows, type RosterRow } from '../../home/roster-contract';
import { fetchWorkList } from '../../lib/work-client';

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

  if (!session) return <SectionShell title={title}><p>Not signed in.</p></SectionShell>;

  return (
    <SectionShell title={title}>
      <p className="manage-card-blurb" style={{ marginTop: 0 }}>
        The people in this workspace and how to reach them. Deciding who belongs is Settings &rarr;
        Membership.
      </p>
      {error && <p style={errorText}>{error}</p>}
      {members === null ? (
        <p style={mutedText}>Reading the roster…</p>
      ) : members.length === 0 ? (
        <p className="manage-card-blurb">
          No members yet. Invite someone under Settings &rarr; Membership, and they appear here once they
          accept.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: '.5rem' }}>
          {rosterRows({ members, executors }).map((m: RosterRow) => {
            const you = !!agentAddress && m.address.toLowerCase() === agentAddress.toLowerCase();
            return (
              <div
                key={m.address}
                // Spec 361 I6 — selecting a member is context the Ask can use ("invite her", "message him"):
                // the reference reaches the agent as validated context, never as words in a prompt.
                role="button" tabIndex={0} aria-pressed={selected === m.address.toLowerCase()}
                onClick={() => { const next = selected === m.address.toLowerCase() ? null : m.address.toLowerCase(); setSelected(next); setAskSelection(next ? { entity: next as `0x${string}`, kind: 'person', label: m.displayName || m.address } : null); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (e.currentTarget as HTMLDivElement).click(); } }}
                style={{ ...cardSty, display: 'flex', alignItems: 'center', gap: '.7rem', flexWrap: 'wrap', cursor: 'pointer', outline: selected === m.address.toLowerCase() ? '2px solid var(--color-sage-700, #3f6212)' : undefined }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '.9rem' }}>
                    {m.displayName}{you && <span style={{ ...mutedText, fontWeight: 400 }}> (you)</span>}
                  </div>
                  {m.publicName && <div style={{ ...mutedText, fontSize: '.78rem' }}>{m.publicName}</div>}
                  {/* Spec 368 — a household membership says how they are related and who is responsible for
                      whom: two facts, two words, neither of which grants anything. */}
                  {(m.kin || (m.role && m.role !== 'member')) && (
                    <div style={{ ...mutedText, fontSize: '.78rem' }} data-testid={`member-facets-${m.address}`}>
                      {m.kin ? `${m.kin}` : ''}{m.kin && m.role && m.role !== 'member' ? ' · ' : ''}{m.role && m.role !== 'member' ? m.role : ''}
                    </div>
                  )}
                  <div style={{ marginTop: '.25rem' }}><AddressChip address={m.address as `0x${string}`} size="sm" /></div>
                  {/* Spec 398 §4.5 — the roster contract: type · sponsor · responsibility · permissions · active work. */}
                  <div style={{ ...mutedText, fontSize: '.72rem', marginTop: '.3rem', display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: '.5rem', rowGap: 1 }} data-testid={`member-contract-${m.address}`}>
                    <span>type</span><span>{m.type}</span>
                    <span>sponsor</span><span>{m.sponsor}</span>
                    <span>responsibility</span><span>{m.responsibility ?? 'none assigned'}</span>
                    <span>permissions</span><span>{m.permissions}</span>
                    <span>active work</span><span>{you ? (m.activeWork === 0 ? 'none' : `${m.activeWork} item${m.activeWork === 1 ? '' : 's'}`) : 'not visible to you (§12 — their own view)'}</span>
                  </div>
                </div>
                {!you && (
                  <a className="btn-ghost" href={`/messages?to=${m.address}`} style={{ textDecoration: 'none', fontSize: '.8rem' }}>
                    Message
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </SectionShell>
  );
}
