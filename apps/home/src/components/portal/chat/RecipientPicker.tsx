'use client';
// The "To:" picker for a new direct message (spec 313 §2.1, W6b).
//
// SCOPE FIRST, THEN A LIST, THEN FILTER AS YOU TYPE. Slack's To: field only knows the workspace; ours
// has three places a person can be found, and a member of an organization may have NO naming-service
// name at all — they are still addressable, by the name the organization knows them by. So the row
// starts with a scope switch (Names · Organizations · Workspaces), the org/workspace scopes add a
// second select for WHICH one, and the list below is populated on scope selection and narrowed by
// what is typed. Every pick resolves to an ADDRESS (ADR-0010).
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { agentClassOf } from '../../../lib/agent-class';
import { useManagedAgents } from '../ManagedAgents';
import { AvatarUpload } from './AvatarUpload';
import { personAvatarKey } from '../../../lib/avatar-store';
import { useAvatar } from './use-avatar';
import {
  fetchRoster,
  filterRecipients,
  listNamedAgents,
  type PickedRecipient,
  type RecipientScope,
} from '../../../lib/recipient-directory';

function GlobeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}
function OrgIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5M9 11h.01M15 11h.01M9 14h.01M15 14h.01" />
    </svg>
  );
}
function WorkspaceIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" />
    </svg>
  );
}

const SCOPES: { id: RecipientScope; label: string; Icon: () => ReactElement; hint: string }[] = [
  { id: 'names', label: 'Names', Icon: GlobeIcon, hint: 'Anyone with a naming-service name' },
  { id: 'organization', label: 'Organizations', Icon: OrgIcon, hint: 'Members of an organization you belong to — including members without a public name' },
  { id: 'workspace', label: 'Workspaces', Icon: WorkspaceIcon, hint: 'Members of a team or app workspace you belong to' },
];

function Row({ r, onPick, known }: { r: PickedRecipient; onPick: (r: PickedRecipient) => void; known?: boolean }) {
  const imageUrl = useAvatar(personAvatarKey(r.address));
  return (
    <button type="button" role="option" className="chat-compose-result" onClick={() => onPick(r)}>
      <AvatarUpload name={r.title} imageUrl={imageUrl} size={28} />
      <span className="chat-compose-result__name">{r.title}</span>
      {r.subtitle && <span className="chat-compose-result__sub">{r.subtitle}</span>}
      {known && <span className="chat-compose-result__tag">recent</span>}
    </button>
  );
}

export function RecipientPicker({
  token,
  query,
  onQuery,
  onPick,
  onCancel,
  recents,
}: {
  token: string;
  query: string;
  onQuery: (q: string) => void;
  onPick: (r: PickedRecipient) => void;
  onCancel: () => void;
  /** People you already DM (address → title) — ranked first under the Names scope. */
  recents: readonly { address: string; title: string }[];
}) {
  const [scope, setScope] = useState<RecipientScope>('names');
  const [container, setContainer] = useState<string>('');
  const [rows, setRows] = useState<PickedRecipient[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Which organizations / workspaces the person can pick from — their managed-agents set (steward AND
  // member). Org-class kinds are organizations; teams + app workspaces are the workspace scope.
  const { agents, loaded } = useManagedAgents(token);
  const containers = useMemo(() => {
    const isOrg = (k: string) => agentClassOf(k as never) === 'org' && k !== 'team';
    const list = agents.filter((a) => (scope === 'organization' ? isOrg(a.kind) : scope === 'workspace' ? a.kind === 'team' || a.kind === 'workspace' : false));
    return list.map((a) => ({ id: a.agent.toLowerCase(), name: a.name || `${a.agent.slice(0, 6)}…${a.agent.slice(-4)}`, kind: a.kind }));
  }, [agents, scope]);

  // Default the container to the first available when the scope changes.
  useEffect(() => {
    if (scope === 'names') { setContainer(''); return; }
    if (!containers.some((c) => c.id === container)) setContainer(containers[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, containers]);

  // Populate the list on scope / container selection (and, for Names, re-query the KB as you type so
  // the cap on the initial "everyone" list never hides someone the person is spelling out).
  const namesQuery = scope === 'names' ? query.trim().toLowerCase() : '';
  useEffect(() => {
    let cancelled = false;
    setNote(null);
    if (scope !== 'names' && !container) { setRows(containers.length === 0 && loaded ? [] : null); return; }
    setLoading(true);
    const t = window.setTimeout(() => {
      const load: Promise<PickedRecipient[]> = scope === 'names'
        ? listNamedAgents(namesQuery.length >= 2 ? namesQuery : '')
        : fetchRoster(token, container).then((roster) =>
            roster.map((m) => ({
              address: m.address,
              title: m.displayName,
              subtitle: m.publicName ?? (m.role ? m.role : undefined),
              ...(m.publicName ? { name: m.publicName } : {}),
              scope,
            })),
          );
      void load
        .then((r) => { if (!cancelled) setRows(r); })
        .catch((e) => { if (!cancelled) { setRows([]); setNote(e instanceof Error ? e.message : String(e)); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, scope === 'names' && namesQuery ? 250 : 0);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [scope, container, token, namesQuery, containers.length, loaded]);

  const recentRows = useMemo(() => {
    if (scope !== 'names') return [] as PickedRecipient[];
    return filterRecipients(recents.map((r) => ({ address: r.address, title: r.title, subtitle: `${r.address.slice(0, 6)}…${r.address.slice(-4)}`, scope: 'names' as const })), query);
  }, [recents, query, scope]);
  const listed = useMemo(() => {
    const recentAddrs = new Set(recentRows.map((r) => r.address));
    return filterRecipients(rows ?? [], query).filter((r) => !recentAddrs.has(r.address));
  }, [rows, query, recentRows]);
  const first = recentRows[0] ?? listed[0];
  const scopeMeta = SCOPES.find((s) => s.id === scope)!;

  return (
    <>
      <div className="chat-compose-to">
        <span className="chat-compose-to__label">To:</span>
        <div className="chat-scope" role="tablist" aria-label="Where to find the recipient">
          {SCOPES.map(({ id, label, Icon, hint }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={scope === id}
              className={`chat-scope__tab${scope === id ? ' chat-scope__tab--active' : ''}`}
              title={hint}
              onClick={() => setScope(id)}
            >
              <Icon /><span>{label}</span>
            </button>
          ))}
        </div>
        {scope !== 'names' && (
          <select
            className="chat-scope__select"
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            aria-label={scope === 'organization' ? 'Organization' : 'Workspace'}
            disabled={containers.length === 0}
          >
            {containers.length === 0 && <option value="">{loaded ? `No ${scope === 'organization' ? 'organizations' : 'workspaces'} yet` : 'Loading…'}</option>}
            {containers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.kind !== 'org' ? ` · ${c.kind}` : ''}</option>)}
          </select>
        )}
        <input
          autoFocus
          className="chat-compose-to__input"
          placeholder={scope === 'names' ? 'Type a name…' : 'Filter members…'}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && first) onPick(first);
            if (e.key === 'Escape') onCancel();
          }}
          aria-label="Recipient"
          aria-autocomplete="list"
        />
      </div>
      <div className="chat-compose-results" role="listbox" aria-label={scopeMeta.label}>
        {recentRows.map((r) => <Row key={`recent:${r.address}`} r={r} onPick={onPick} known />)}
        {loading && <div className="chat-compose-result chat-compose-result--note">Loading {scopeMeta.label.toLowerCase()}…</div>}
        {note && <div className="chat-compose-result chat-compose-result--note" style={{ color: 'var(--color-danger)' }}>{note}</div>}
        {!loading && !note && rows && listed.length === 0 && recentRows.length === 0 && (
          <div className="chat-compose-result chat-compose-result--note">
            {query.trim() ? <>No one matches &ldquo;{query.trim()}&rdquo;.</> : scope === 'names' ? 'No named agents indexed yet.' : containers.length === 0 ? `You don't belong to any ${scope === 'organization' ? 'organizations' : 'workspaces'} yet.` : 'No members listed.'}
          </div>
        )}
        {listed.map((r) => <Row key={`${r.scope}:${r.address}`} r={r} onPick={onPick} />)}
      </div>
    </>
  );
}
