'use client';
// Home-side org chooser for an org-create enroll that arrives WITHOUT a preselected org
// (`org_base` / `existing_org` absent): the member picks an organization they already
// steward — the Home then GRANTS from it, no deploy — or names a new one to deploy.
//
// Selection deliberately lives HERE, not at the relying app: a relying app's related-orgs
// view is scoped to the orgs it already holds a grant for (spec 246), so it can never
// offer an org created elsewhere (another app, the home portal). The member's own home
// session can — person↔org links are private vault credentials the home reads (ADR-0025).
//
// Listing stewarded orgs needs a home session token. Without one (e.g. a passkey member
// whose `ap_sso` cookie is gone) we say so explicitly and offer create-new only — a
// visible degradation, never a silent empty list (ADR-0013: the missing session is
// surfaced, not swallowed).
import { useEffect, useState, type CSSProperties } from 'react';
import type { Address } from '@agenticprimitives/types';
import { listManagedAgents } from '../../connect-client';

export interface OrgChoice {
  /** Set when the member picked an org they already steward (grant-only, no deploy). */
  existingOrg?: Address;
  /** The org's display name (existing) or the new org's label to claim. */
  orgName: string;
  /** True when they can sign as the org. Members connect as themselves with this org as context. */
  asSteward?: boolean;
}

/** Same slug rule the relying apps use app-side: the `.impact` subregistry only accepts
 *  `[a-z0-9-]`, so normalize BEFORE the ceremony instead of failing at the name claim. */
export function toOrgLabel(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

const rowSty = (on: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: '.7rem',
  padding: '.6rem .8rem',
  border: `1.5px solid ${on ? 'var(--color-accent, #2563eb)' : 'var(--color-border-strong, #d1d5db)'}`,
  borderRadius: 12,
  background: on ? 'var(--color-accent-soft, #eff6ff)' : 'var(--color-surface, #fff)',
  cursor: 'pointer',
  textAlign: 'left',
  position: 'relative',
});

// Visually-hidden but focusable/announced radio — the whole row is the control.
const srRadio: CSSProperties = { position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' };

const orgHue = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
};

function OrgAvatar({ name, plus }: { name: string; plus?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 38, height: 38, flex: '0 0 38px', borderRadius: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 700, fontSize: '1.05rem',
        color: plus ? 'var(--color-accent, #2563eb)' : '#fff',
        background: plus ? 'transparent' : `hsl(${orgHue(name)}, 45%, 48%)`,
        border: plus ? '1.5px dashed var(--color-accent, #2563eb)' : 'none',
      }}
    >
      {plus ? '+' : (name.replace(/\..*$/, '').slice(0, 1).toUpperCase() || '?')}
    </span>
  );
}

export function OrgChooser({
  token,
  appHost,
  onChoose,
  onDecline,
}: {
  /** Home-session bearer (aud = home). Absent → create-new only, with the reason shown. */
  token?: string;
  appHost: string;
  onChoose: (choice: OrgChoice) => void;
  onDecline: () => void;
}) {
  // null = loading; [] = none (or no session to list with).
  const [orgs, setOrgs] = useState<Array<{ agent: Address; name: string }> | null>(token ? null : []);
  const [selected, setSelected] = useState<'new' | Address>('new');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    listManagedAgents(token)
      .then((agents) => {
        if (cancelled) return;
        // Only orgs the member STEWARDS qualify — a grant from the org is signed with the
        // member's custody of it; 'member' links and treasuries are not grantable-from here.
        const stewarded = agents
          .filter((a) => a.kind === 'org' && a.relationship !== 'member' && a.name)
          .map((a) => ({ agent: a.agent, name: a.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setOrgs(stewarded);
        if (stewarded.length > 0) setSelected(stewarded[0].agent);
      })
      .catch(() => { if (!cancelled) setOrgs([]); });
    return () => { cancelled = true; };
  }, [token]);

  if (orgs === null) {
    return (
      <div className="onboarding-busy">
        <span className="spinner spinner-lg" role="status" aria-label="Loading your organizations" />
        <p className="onboarding-busy-msg">Finding organizations you steward…</p>
      </div>
    );
  }

  const chosen = selected !== 'new' ? orgs.find((o) => o.agent.toLowerCase() === selected.toLowerCase()) : undefined;
  const slug = toOrgLabel(name);

  const go = () => {
    if (chosen) return onChoose({ existingOrg: chosen.agent, orgName: chosen.name });
    if (slug.length < 3) { setErr('Give the new organization a name of at least 3 letters or numbers.'); return; }
    onChoose({ orgName: slug });
  };

  return (
    <>
      <h1 className="onboarding-h1">Which organization will you connect to {appHost}?</h1>
      <p className="onboarding-sub">
        Pick an organization you already steward, or create a new one. Either way it stays custodied by
        you — {appHost} only receives a scoped, revocable grant.
      </p>
      {!token && (
        <p className="onboarding-hint">
          You&apos;re not signed in at your home right now, so organizations you already steward can&apos;t be
          listed — you can still create a new one below.
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.55rem', margin: '1rem 0' }}>
        {orgs.length > 0 && (
          <p style={{ fontSize: '.72rem', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', opacity: 0.55, margin: '0 0 .1rem' }}>
            Organizations you steward
          </p>
        )}
        {orgs.map((o) => {
          const on = selected.toLowerCase() === o.agent.toLowerCase();
          return (
            <label key={o.agent} style={rowSty(on)}>
              <input type="radio" name="org-choice" style={srRadio} checked={on} onChange={() => { setSelected(o.agent); setErr(''); }} />
              <OrgAvatar name={o.name} />
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.name}</span>
                <span style={{ fontSize: '.72rem', opacity: 0.6, fontFamily: 'ui-monospace, monospace' }}>
                  {o.agent.slice(0, 10)}…{o.agent.slice(-6)}
                </span>
              </span>
              {on && <span aria-hidden style={{ color: 'var(--color-accent, #2563eb)', fontWeight: 700, fontSize: '1.1rem' }}>✓</span>}
            </label>
          );
        })}
        {orgs.length > 0 && (
          <label style={rowSty(selected === 'new')}>
            <input type="radio" name="org-choice" style={srRadio} checked={selected === 'new'} onChange={() => { setSelected('new'); setErr(''); }} />
            <OrgAvatar name="+" plus />
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
              <span style={{ fontWeight: 700 }}>Create a new organization</span>
              <span style={{ fontSize: '.72rem', opacity: 0.6 }}>Deploys a new Smart Agent, custodied by you</span>
            </span>
            {selected === 'new' && <span aria-hidden style={{ color: 'var(--color-accent, #2563eb)', fontWeight: 700, fontSize: '1.1rem' }}>✓</span>}
          </label>
        )}
        {selected === 'new' && (
          <input
            className="onboarding-input"
            placeholder="New organization name"
            value={name}
            autoFocus={orgs.length === 0}
            onChange={(e) => { setName(e.target.value); setErr(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
          />
        )}
        {selected === 'new' && slug && slug !== name.trim() && (
          <p className="onboarding-hint">Registered as <strong>{slug}</strong> — spaces &amp; capitals are normalized to a web-safe handle.</p>
        )}
      </div>
      {err && <p className="onboarding-hint taken">{err}</p>}
      <button className="btn-primary" onClick={go}>
        {chosen ? `Continue with ${chosen.name}` : 'Continue with a new organization'}
      </button>
      <button className="btn-ghost onboarding-secondary" onClick={onDecline}>Cancel</button>
    </>
  );
}
