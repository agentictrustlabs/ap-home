'use client';
// TODAY — spec 398 §4.2, the first page of every workspace (the nav's first slot, 348's grammar kept). Outcome-led,
// in a FIXED order: decisions awaiting me → active goals → recent artifacts → routine exceptions → one suggested
// next act. No message counts, no infrastructure statistics. Every card points at the surface that owns the act
// (Work, the Ask, the Library, the Playbook) — nothing here executes: an approval is signed where approvals are
// signed. The assembly is `src/home/today.ts` (pure, table-tested); this component only fetches and renders.
import { useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { listRuns, listTriggers, homeVocabulary, type ParkedRun, type TriggerRow, type AskVocabularyEntry } from '../../home/ask';
import { assembleToday, type Today, type TodayItem, type TodayArtifact } from '../../home/today';
import { useMyWork } from './work/useWork';
import { StatePill } from './StatePill';
import { workspaceHref, type WorkspaceScope } from '../../lib/workspace';
import type { RunStateV1 } from '../../home/run-state';

const RECENT_DAYS = 7;

function Section({ title, hint, items, empty, children }: { title: string; hint: string; items?: TodayItem[]; empty: string; children?: React.ReactNode }) {
  return (
    <section className="dash-section" data-testid={`today-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
      <h2 style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
        {title}
        {items && items.length > 0 && <span style={{ fontSize: '0.74rem', fontWeight: 400, opacity: 0.6 }}>{items.length}</span>}
      </h2>
      <p className="manage-card-blurb">{hint}</p>
      {children ?? (items && items.length === 0 ? <p className="muted" style={{ fontSize: '0.8rem' }}>{empty}</p> : null)}
      {!children && items && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {items.map((it) => <Card key={it.id} item={it} />)}
        </div>
      )}
    </section>
  );
}

function Card({ item }: { item: TodayItem }) {
  const href = item.href ?? (item.askSeed ? `/ask?seed=${encodeURIComponent(item.askSeed)}` : undefined);
  const body = (
    <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: '0.86rem', lineHeight: 1.35 }}>{item.title}</div>
        {item.detail && <div style={{ fontSize: '0.73rem', opacity: 0.65, marginTop: '0.15rem' }}>{item.detail}</div>}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flex: 'none' }}>
        {item.state && <StatePill state={item.state} {...(item.native ? { native: item.native } : {})} />}
        {item.at && <span style={{ fontSize: '0.7rem', opacity: 0.55 }}>{new Date(item.at).toLocaleDateString()}</span>}
      </div>
    </div>
  );
  const style = { display: 'block', padding: '0.6rem 0.85rem', textDecoration: 'none', color: 'inherit' } as const;
  return href
    ? <a className="manage-card" href={href} style={style} data-testid="today-card">{body}</a>
    : <div className="manage-card" style={style} data-testid="today-card">{body}</div>;
}

/** Which agent Today is ABOUT: the person's own, or the workspace's organization / service. The decisions and
 *  goals of a person span their organizations; an organization's Today is that organization's alone. */
function addresseeOf(scope: WorkspaceScope, self: string | null | undefined): string | null {
  if (scope.kind === 'org') return scope.org.toLowerCase();
  if (scope.kind === 'service') return scope.agent.toLowerCase();
  return self ? self.toLowerCase() : null;
}

export function TodayView({ scope, children }: { scope: WorkspaceScope; children?: React.ReactNode }) {
  const { session, agentAddress } = useSession();
  const addressee = addresseeOf(scope, agentAddress);
  const { bundles } = useMyWork(session, agentAddress);
  const [parked, setParked] = useState<Array<ParkedRun & { state?: RunStateV1 }> | null>(null);
  const [triggers, setTriggers] = useState<TriggerRow[]>([]);
  const [vocabulary, setVocabulary] = useState<AskVocabularyEntry[]>([]);
  const [artifacts, setArtifacts] = useState<TodayArtifact[]>([]);

  useEffect(() => {
    if (!session || !addressee) return;
    let live = true;
    const token = session.token;
    void listRuns({ token }, addressee as Address).then((rs) => { if (live) setParked(rs as Array<ParkedRun & { state?: RunStateV1 }>); }).catch(() => { if (live) setParked([]); });
    void listTriggers({ token }, addressee as Address).then((ts) => { if (live) setTriggers(ts); }).catch(() => undefined);
    void homeVocabulary(addressee).then((v) => { if (live) setVocabulary(v); }).catch(() => undefined);
    const scopeQ = scope.kind === 'person' ? '' : `?org=${addressee}`;
    void fetch(`/connect/library${scopeQ}`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { artifacts: [] }))
      .then((b: { artifacts?: Array<{ id: string; name: string; kind?: string; folder?: string; createdAt?: number; version?: number; isFolder?: boolean }> }) => {
        if (!live) return;
        setArtifacts((b.artifacts ?? []).filter((a) => !a.isFolder && typeof a.createdAt === 'number').map((a) => ({ id: a.id, name: a.name, createdAt: a.createdAt as number, ...(a.kind ? { kind: a.kind } : {}), ...(a.folder ? { folder: a.folder } : {}), ...(a.version ? { version: a.version } : {}) })));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [session?.token, addressee, scope.kind]);

  const today: Today | null = useMemo(() => {
    if (parked === null) return null;
    // An organization's Today shows that organization's work only; a person's spans every organization.
    const mine = scope.kind === 'org' ? (bundles ?? []).filter((b) => b.org.toLowerCase().endsWith(scope.org.toLowerCase())) : scope.kind === 'service' ? [] : bundles;
    return assembleToday({ now: Date.now(), parked, bundles: mine, artifacts, triggers, vocabulary, recentDays: RECENT_DAYS });
  }, [parked, bundles, artifacts, triggers, vocabulary, scope]);

  const libraryHref = workspaceHref(scope, 'library');
  const playbookHref = workspaceHref(scope, 'playbook');

  if (!session) return null;
  return (
    <div className="today" data-testid="today">
      {today === null && <p className="muted" style={{ fontSize: '0.8rem' }}>Reading what needs you…</p>}
      {today && (
        <>
          <Section title="Needs your decision" hint="A signature, a decision you were named to make, a commitment waiting on you. Each opens where it is signed." items={today.decisions} empty="Nothing is waiting on you." />
          <Section title="Active goals" hint="What your agent is doing and what you committed to, with its state." items={today.active} empty="Nothing in motion. Ask for something, or take on work." />
          <Section title="Recent artifacts" hint={`What the last ${RECENT_DAYS} days left in the Library.`} items={today.artifacts} empty="No new artifacts this week." />
          {today.artifacts.length > 0 && <p style={{ fontSize: '0.76rem', marginTop: '-0.6rem' }}><a href={libraryHref}>Open the Library →</a></p>}
          <Section title="Routine exceptions" hint="A scheduled or hooked routine whose last firing failed." items={today.exceptions} empty="Every routine's last firing went through." />
          {today.exceptions.length > 0 && <p style={{ fontSize: '0.76rem', marginTop: '-0.6rem' }}><a href={playbookHref}>Open the Playbook →</a></p>}
          <Section title="Next" hint="One act this agent's playbook offers here — drawn from its vocabulary, never a fixed list." empty="This agent offers nothing to suggest yet: choose a playbook for it.">
            {today.next
              ? <Card item={today.next} />
              : <p className="muted" style={{ fontSize: '0.8rem' }}>This agent offers nothing to suggest yet: choose a playbook for it.</p>}
          </Section>
        </>
      )}
      {children}
    </div>
  );
}
