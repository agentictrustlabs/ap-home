'use client';
// Home-side org chooser for an org-create enroll that arrives WITHOUT a preselected org
// (`org_base` / `existing_org` absent): the person picks an organization they belong to
// (membership, or a stewarded org created for this request's purpose) — or names a new
// one to deploy. Unrelated stewarded orgs are not offered.
//
// Selection deliberately lives HERE, not at the relying app: a relying app's related-orgs
// view is scoped to the orgs it already holds a grant for (spec 246), so it can never
// offer an org created elsewhere (another app, the home portal). The member's own home
// session can — person↔org links are private vault credentials the home reads (ADR-0025).
//
// Listing related orgs needs a home session token. Without one (e.g. a passkey member
// whose `ap_sso` cookie is gone) we say so explicitly and offer create-new only — a
// visible degradation, never a silent empty list (ADR-0013: the missing session is
// surfaced, not swallowed).
import { useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { listManagedAgents } from '../../connect-client';
import { shortAppHost, toOrgLabel } from './org-chooser-label';
import { canGrantAsOrg, eligibleConnectOrgs } from './org-chooser-eligible';

export { shortAppHost, toOrgLabel } from './org-chooser-label';

export interface OrgChoice {
  /** Set when the person picked an organization they already belong to (no deploy). */
  existingOrg?: Address;
  /** The org's display name (existing) or the new org's label to claim. */
  orgName: string;
  /** True when they can sign as the org. Members connect as themselves with this org as context. */
  asSteward?: boolean;
}

const orgHue = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
};

function OrgAvatar({ name, plus }: { name: string; plus?: boolean }) {
  return (
    <span
      aria-hidden
      className={`org-chooser-avatar${plus ? ' plus' : ''}`}
      style={plus ? undefined : { background: `hsl(${orgHue(name)}, 45%, 48%)` }}
    >
      {plus ? '+' : (name.replace(/\..*$/, '').slice(0, 1).toUpperCase() || '?')}
    </span>
  );
}

export function OrgChooser({
  token,
  appHost,
  purpose,
  onChoose,
  onDecline,
}: {
  /** Home-session bearer (aud = home). Absent → create-new only, with the reason shown. */
  token?: string;
  appHost: string;
  /** `org_purpose` from the enroll. When set, stewarded orgs for other purposes are hidden. */
  purpose?: string;
  onChoose: (choice: OrgChoice) => void;
  onDecline: () => void;
}) {
  // null = loading; [] = none (or no session to list with).
  const [orgs, setOrgs] = useState<Array<{ agent: Address; name: string; asSteward: boolean }> | null>(token ? null : []);
  const [selected, setSelected] = useState<'new' | Address>('new');
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    listManagedAgents(token)
      .then((agents) => {
        if (cancelled) return;
        const listed = eligibleConnectOrgs(agents, { purpose }).map((a) => ({
          agent: a.agent,
          name: a.name,
          asSteward: canGrantAsOrg(a),
        }));
        setOrgs(listed);
        // Stay on "create new" — this screen is the org-create ceremony. Auto-picking the
        // first stewarded org hid the create action behind a long list and pre-committed
        // the member to an existing org they did not choose.
      })
      .catch(() => { if (!cancelled) setOrgs([]); });
    return () => { cancelled = true; };
  }, [token, purpose]);

  const filtered = useMemo(() => {
    const list = orgs ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((o) => o.name.toLowerCase().includes(q) || o.agent.toLowerCase().includes(q));
  }, [orgs, query]);

  if (orgs === null) {
    return (
      <div className="onboarding-busy">
        <span className="spinner spinner-lg" role="status" aria-label="Loading your organizations" />
        <p className="onboarding-busy-msg">Finding organizations you belong to…</p>
      </div>
    );
  }

  const chosen = selected !== 'new' ? orgs.find((o) => o.agent.toLowerCase() === selected.toLowerCase()) : undefined;
  const slug = toOrgLabel(name);
  const host = shortAppHost(appHost);

  const go = () => {
    if (chosen) return onChoose({ existingOrg: chosen.agent, orgName: chosen.name, asSteward: chosen.asSteward });
    if (slug.length < 3) { setErr('Give the new organization a name of at least 3 letters or numbers.'); return; }
    onChoose({ orgName: slug });
  };

  const pickNew = () => { setSelected('new'); setErr(''); };
  const pickOrg = (agent: Address) => { setSelected(agent); setErr(''); };

  return (
    <div className="org-chooser">
      <h1 className="onboarding-h1">Connect an organization to {host}</h1>
      <p className="onboarding-sub">
        Create a new one, or pick an organization you belong to. {host} only receives a scoped,
        revocable grant — never custody of the organization.
      </p>
      {!token && (
        <p className="onboarding-hint">
          You&apos;re not signed in at your home right now, so organizations you belong to can&apos;t be
          listed — you can still create a new one.
        </p>
      )}

      <label className={`org-chooser-row create${selected === 'new' ? ' on' : ''}`}>
        <input type="radio" name="org-choice" className="org-chooser-sr" checked={selected === 'new'} onChange={pickNew} />
        <OrgAvatar name="+" plus />
        <span className="org-chooser-copy">
          <span className="org-chooser-name">Create a new organization</span>
          <span className="org-chooser-meta">Deploys a new Smart Agent, custodied by you</span>
        </span>
        {selected === 'new' && <span aria-hidden className="org-chooser-check">✓</span>}
      </label>
      {selected === 'new' && (
        <input
          className="onboarding-input"
          placeholder="New organization name"
          value={name}
          autoFocus
          onChange={(e) => { setName(e.target.value); setErr(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
        />
      )}
      {selected === 'new' && slug && slug !== name.trim() && (
        <p className="onboarding-hint">Registered as <strong>{slug}</strong> — spaces &amp; capitals become a web-safe handle.</p>
      )}

      {orgs.length > 0 && (
        <>
          <p className="org-chooser-section">
            Or use one you belong to
            <span className="org-chooser-count">{orgs.length}</span>
          </p>
          {orgs.length > 5 && (
            <input
              className="onboarding-input org-chooser-filter"
              type="search"
              placeholder="Filter organizations"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter organizations you belong to"
            />
          )}
          <div className="org-chooser-list" role="listbox" aria-label="Organizations you belong to">
            {filtered.length === 0 && (
              <p className="onboarding-hint">No organization you belong to matches that filter.</p>
            )}
            {filtered.map((o) => {
              const on = selected.toLowerCase() === o.agent.toLowerCase();
              return (
                <label key={o.agent} className={`org-chooser-row${on ? ' on' : ''}`}>
                  <input type="radio" name="org-choice" className="org-chooser-sr" checked={on} onChange={() => pickOrg(o.agent)} />
                  <OrgAvatar name={o.name} />
                  <span className="org-chooser-copy">
                    <span className="org-chooser-name">{o.name}</span>
                    <span className="org-chooser-meta">
                      {o.asSteward ? 'You steward this organization' : 'You’re a member'}
                      {' · '}
                      {o.agent.slice(0, 8)}…{o.agent.slice(-4)}
                    </span>
                  </span>
                  {on && <span aria-hidden className="org-chooser-check">✓</span>}
                </label>
              );
            })}
          </div>
        </>
      )}

      {err && <p className="onboarding-hint taken">{err}</p>}
      <button className="btn-primary" onClick={go}>
        {chosen ? `Continue with ${chosen.name}` : 'Create organization'}
      </button>
      <button className="btn-ghost onboarding-secondary" onClick={onDecline}>Cancel</button>
    </div>
  );
}
