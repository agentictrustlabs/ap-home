'use client';
// The "To:" picker for a new direct message (spec 313 §2.1, W6b).
//
// SLACK'S "NEW MESSAGE", WITH SCOPES. One search box. Beneath it, two panes: on the left WHERE to look
// — Names (the naming service), then each Organization you belong to, then each Workspace (team / app
// workspace) — and on the right WHO is there, narrowed by what you typed. Selecting a scope populates
// the right pane; typing filters it. A member of an organization may have NO naming-service name at
// all — they are still listed, by the name the organization knows them by, and picked by ADDRESS
// (ADR-0010). Picking never authorizes: the first send to a new counterparty still runs the wire
// ceremony.
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { playbookBehind, playbookBehindWords } from '../../../home/playbook-behind';
import { agentClassOf } from '../../../lib/agent-class';
import { useManagedAgents } from '../ManagedAgents';
import { useSession } from '../../../context/session';
import { readContactsThroughHarness } from '../../../home/contacts-harness';
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
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}
function OrgIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5M9 11h.01M15 11h.01M9 14h.01M15 14h.01" />
    </svg>
  );
}
function WorkspaceIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" />
    </svg>
  );
}

/** One entry in the left pane: the naming service, or a specific organization / workspace. */
interface ScopeEntry {
  id: string; // 'names' | the container SA (lowercase)
  scope: RecipientScope;
  label: string;
  sub?: string;
  Icon: () => ReactElement;
}

function Row({ r, onPick, tag }: { r: PickedRecipient; onPick: (r: PickedRecipient) => void; tag?: string }) {
  const imageUrl = useAvatar(personAvatarKey(r.address));
  return (
    <button type="button" role="option" className="chat-compose-result" data-testid={`dm-recipient-${r.address}`} onClick={() => onPick(r)}>
      <AvatarUpload name={r.title} imageUrl={imageUrl} size={30} />
      <span className="chat-compose-result__text">
        <span className="chat-compose-result__name">{r.title}</span>
        <span className="chat-compose-result__sub">{r.subtitle ?? `${r.address.slice(0, 6)}…${r.address.slice(-4)}`}</span>
      </span>
      {tag && <span className="chat-compose-result__tag">{tag}</span>}
      {!tag && !r.name && r.scope !== 'names' && <span className="chat-compose-result__tag" title="No naming-service name — reached by their agent address">unnamed</span>}
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
  names,
}: {
  token: string;
  query: string;
  onQuery: (q: string) => void;
  onPick: (r: PickedRecipient) => void;
  onCancel: () => void;
  /** People you already DM (address → title) — ranked first under Names, like Slack's recents. */
  recents: readonly { address: string; title: string }[];
  /** Naming-service names the Home has already resolved (lowercase address → name) — labels a roster
   *  member who chose no join name, instead of showing their address. */
  names?: Readonly<Record<string, string>>;
}) {
  const [selected, setSelected] = useState<string>('contacts');
  const [rows, setRows] = useState<PickedRecipient[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The left pane: Names, then every org-class agent the person belongs to (steward or member), then
  // every team / app workspace. All from the managed-agents set — the same list the workspace
  // switcher shows, so nothing appears here that the person cannot already act within.
  const { agents, loaded } = useManagedAgents(token);
  const entries = useMemo<ScopeEntry[]>(() => {
    const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
    const orgs: ScopeEntry[] = [];
    const spaces: ScopeEntry[] = [];
    for (const a of agents) {
      const id = a.agent.toLowerCase();
      const label = a.name || short(a.agent);
      if (a.kind === 'team' || a.kind === 'workspace') {
        spaces.push({ id, scope: 'workspace', label, sub: a.kind === 'team' ? 'team' : 'app workspace', Icon: WorkspaceIcon });
      } else if (agentClassOf(a.kind) === 'org') {
        orgs.push({ id, scope: 'organization', label, sub: a.kind === 'org' ? undefined : a.kind, Icon: OrgIcon });
      }
    }
    const byLabel = (x: ScopeEntry, y: ScopeEntry) => x.label.localeCompare(y.label, undefined, { sensitivity: 'base' });
    return [
      // Spec 401 — CONTACTS FIRST: the people and agents the person let in, from their own vault; the derived scopes
      // (names, organizations, workspaces) follow.
      { id: 'contacts', scope: 'contacts', label: 'Contacts', sub: 'people and agents you let in', Icon: GlobeIcon },
      { id: 'names', scope: 'names', label: 'Names', sub: 'naming service', Icon: GlobeIcon },
      ...orgs.sort(byLabel),
      ...spaces.sort(byLabel),
    ];
  }, [agents]);
  const { agentAddress } = useSession();
  const active = entries.find((e) => e.id === selected) ?? entries[0]!;

  // Populate the right pane on scope selection. Under Names, re-query the KB as you type so the cap on
  // the initial "everyone" list never hides someone the person is spelling out.
  const namesQuery = active.scope === 'names' ? query.trim().toLowerCase() : '';
  useEffect(() => {
    let cancelled = false;
    setNote(null);
    setLoading(true);
    // A scope switch must never show the PREVIOUS scope's people under the new title, even for a
    // frame — a stale list is a wrong list. Names re-queries keep their rows while the filter refines.
    if (active.scope !== 'names' || !namesQuery) setRows(null);
    const t = window.setTimeout(() => {
      const load: Promise<PickedRecipient[]> = active.scope === 'contacts'
        ? (agentAddress ? readContactsThroughHarness({ person: agentAddress as `0x${string}`, session: { token } }).then((r) => (r.ok ? r.contacts.map((c) => ({ address: c.contact.toLowerCase(), title: c.name ?? `${c.contact.slice(0, 6)}…${c.contact.slice(-4)}`, subtitle: c.role, ...(c.name ? { name: c.name } : {}), scope: 'contacts' as const })) : Promise.reject(new Error(r.error)))) : Promise.resolve([]))
        : active.scope === 'names'
        ? listNamedAgents(namesQuery.length >= 2 ? namesQuery : '')
        : fetchRoster(token, active.id).then((roster) =>
            roster.map((m) => {
              const known = m.publicName ?? names?.[m.address];
              const chose = !/^0x[0-9a-f]{4}…[0-9a-f]{4}$/.test(m.displayName);
              return {
                address: m.address,
                title: chose ? m.displayName : known ?? m.displayName,
                subtitle: chose ? known ?? m.role : m.role,
                ...(known ? { name: known } : {}),
                scope: active.scope,
              };
            }),
          );
      void load
        .then((r) => { if (!cancelled) setRows(r); })
        .catch((e) => { if (!cancelled) { setRows([]); const msg = e instanceof Error ? e.message : String(e); const behind = playbookBehind(msg); setNote(behind ? playbookBehindWords(behind.toolId) : msg); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, active.scope === 'names' && namesQuery ? 250 : 0);
    return () => { cancelled = true; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.id, active.scope, token, namesQuery]);

  const recentRows = useMemo(() => {
    if (active.scope !== 'names') return [] as PickedRecipient[];
    return filterRecipients(recents.map((r) => ({ address: r.address, title: r.title, scope: 'names' as const })), query);
  }, [recents, query, active.scope]);
  const listed = useMemo(() => {
    const recentAddrs = new Set(recentRows.map((r) => r.address));
    return filterRecipients(rows ?? [], query).filter((r) => !recentAddrs.has(r.address));
  }, [rows, query, recentRows]);
  const first = recentRows[0] ?? listed[0];

  const groups: { key: string; title: string; items: ScopeEntry[] }[] = [
    { key: 'contacts', title: '', items: entries.filter((e) => e.scope === 'contacts') },
    { key: 'names', title: '', items: entries.filter((e) => e.scope === 'names') },
    { key: 'orgs', title: 'Organizations', items: entries.filter((e) => e.scope === 'organization') },
    { key: 'spaces', title: 'Workspaces', items: entries.filter((e) => e.scope === 'workspace') },
  ];
  const paneTitle = active.scope === 'contacts' ? 'Your contacts' : active.scope === 'names' ? 'People with a name' : `Members of ${active.label}`;

  return (
    <div className="chat-picker" data-testid="dm-picker">
      <div className="chat-compose-to">
        <span className="chat-compose-to__label">To:</span>
        <input
          ref={inputRef}
          autoFocus
          data-testid="dm-compose-to"
          className="chat-compose-to__input"
          placeholder={active.scope === 'names' ? 'Search by name…' : active.scope === 'contacts' ? 'Search your contacts…' : `Search ${active.label}…`}
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
      <div className="chat-picker__panes">
        <nav className="chat-picker__scopes" aria-label="Where to look">
          {groups.map((g) => (
            <div key={g.key} className="chat-picker__group">
              {g.title && <div className="chat-picker__group-title">{g.title}</div>}
              {g.items.length === 0 && g.key !== 'names' && (
                <div className="chat-picker__group-empty">{loaded ? 'none yet' : 'loading…'}</div>
              )}
              {g.items.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`chat-picker__scope${e.id === active.id ? ' chat-picker__scope--active' : ''}`}
                  data-testid={`dm-scope-${e.id}`}
                  onClick={() => { setSelected(e.id); inputRef.current?.focus(); }}
                  title={e.sub ? `${e.label} · ${e.sub}` : e.label}
                >
                  <e.Icon />
                  <span className="chat-picker__scope-label">{e.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="chat-picker__list" role="listbox" aria-label={paneTitle}>
          {recentRows.length > 0 && <div className="chat-picker__section">Recent</div>}
          {recentRows.map((r) => <Row key={`recent:${r.address}`} r={r} onPick={onPick} tag="recent" />)}
          <div className="chat-picker__section">
            {paneTitle}{rows && !loading ? ` · ${listed.length}` : ''}
          </div>
          {loading && <div className="chat-compose-result chat-compose-result--note">Loading…</div>}
          {note && <div className="chat-compose-result chat-compose-result--note" style={{ color: 'var(--color-danger)' }}>{note}</div>}
          {!loading && !note && rows && listed.length === 0 && (
            <div className="chat-compose-result chat-compose-result--note">
              {query.trim()
                ? <>No one matches &ldquo;{query.trim()}&rdquo;.</>
                : active.scope === 'names'
                  ? 'No named agents indexed yet.'
                  : 'No members listed here yet.'}
            </div>
          )}
          {listed.map((r) => <Row key={`${r.scope}:${r.address}`} r={r} onPick={onPick} />)}
        </div>
      </div>
    </div>
  );
}
