'use client';
// Spec 400 W2 (B5) — ONE BOX over the person's own work: their messages, their runs, the topics and runs of the
// organizations they steward. Answered from rebuildable indexes on their own objects, never an engine over decrypted
// copies; every result is a citation — the kind, when, a clip, and where it lives — so the reader opens it there.
import { useCallback, useState, type FormEvent } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { Section, List, Row, Empty, ErrorNote, Note, Button, Chip, Mono, Meta, Tabs } from '../../ui';
import { AgentName } from '../shared/AgentName';
import { searchWorkThroughHarness, type SearchOutcome, type SearchResultRow } from '../../home/search-harness';
import { orgHref } from '../../lib/workspace';

type Kind = 'all' | 'message' | 'topic' | 'run';

function whereOf(r: SearchResultRow): { label: string; href: string } {
  if (r.kind === 'topic' && r.ref.org) return { label: `topic “${r.ref.title ?? r.ref.channelId ?? ''}”`, href: orgHref(r.ref.org, 'discussions') };
  if (r.kind === 'run') return { label: `run ${r.ref.runRef ?? ''}`, href: '/activities' };
  return { label: r.ref.title ? `message · ${r.ref.title}` : 'message', href: '/messages' };
}

export function SearchPanel() {
  const { session, agentAddress } = useSession();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);

  const run = useCallback(async (e?: FormEvent) => {
    e?.preventDefault();
    if (!session || !agentAddress || !query.trim()) return;
    setBusy(true); setError(null);
    const r = await searchWorkThroughHarness({ person: agentAddress as Address, session: { token: session.token }, query: query.trim(), ...(kind === 'all' ? {} : { kinds: [kind] }) });
    setBusy(false);
    if (r.ok) setOutcome(r.outcome); else setError(r.error);
  }, [session, agentAddress, query, kind]);

  return (
    <>
      <form onSubmit={run} className="ui-toolbar" style={{ gap: 8, alignItems: 'center' }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="auth refresh · retreat plan · who is bringing the food" aria-label="Search your work" style={{ flex: 1, minWidth: 200 }} />
        <Button type="submit" variant="primary" disabled={busy || !query.trim()}>{busy ? 'Searching…' : 'Search'}</Button>
      </form>
      <Tabs value={kind} onChange={setKind} label="Kind" items={[{ id: 'all', label: 'Everything' }, { id: 'message', label: 'Messages' }, { id: 'topic', label: 'Topics' }, { id: 'run', label: 'Runs' }]} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {outcome && (
        <Section title={`Results for “${outcome.query}”`} count={outcome.count} aside={<Meta>{outcome.searched.length} place{outcome.searched.length === 1 ? '' : 's'} searched · {outcome.searched.reduce((n, s) => n + s.indexed, 0)} indexed</Meta>}>
          {outcome.results.length === 0 ? (
            <Empty title="Nothing matched every word">{outcome.note ?? 'Try fewer words.'}</Empty>
          ) : (
            <List>
              {outcome.results.map((r) => {
                const w = whereOf(r);
                return (
                  <Row key={r.id} title={<span>{r.snippet || <Meta>(no text)</Meta>}</span>} titleHref={w.href}
                    meta={<span><Chip>{r.kind}</Chip> {new Date(r.at).toLocaleString()} · {w.label}{r.ref.from ? <> · from <AgentName address={r.ref.from as Address} /></> : null} · in {r.where.name ?? r.where.subject}</span>}
                    side={<Mono title={r.id}>{r.ref.messageId ?? r.ref.runRef ?? r.id}</Mono>} />
                );
              })}
            </List>
          )}
        </Section>
      )}
      {!outcome && !error && <Note>Your messages, your runs, and the topics and runs of the organizations you steward — nothing public, nothing you hold no stewardship for. Results cite where each thing lives.</Note>}
    </>
  );
}
