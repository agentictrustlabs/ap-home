'use client';
// spec 275 — "Your agents": the member's whole Smart-Agent tree, managed from their home.
//   Person SA (root, identity)
//    ├─ Person Treasury Service SA
//    └─ Org SA  →  Org Treasury Service SA
// Each is an on-chain SA with an EXACT name, custodied by the member's ROOT passkey, created
// in one gasless prompt. The links are PRIVATE vault credentials (ADR-0025), read back from
// the same /connect/related-orgs vault the orgs view uses (MAM-D7).
import { useEffect, useState } from 'react';
import { createManagedAgent, listManagedAgents, type AgentKind, type ManagedAgent } from '../../connect-client';
import { AddressChip } from '../shared/AddressChip';
import { BuildingIcon, UserIcon } from '../shared/Icons';

const EXPLORER = 'https://sepolia.basescan.org/address/';

const KIND_LABEL: Record<AgentKind, string> = {
  'person-treasury': 'Personal treasury',
  org: 'Organization',
  'org-treasury': 'Org treasury',
};

/** Inline "name it and create" form for one agent slot. */
function CreateForm({
  kind,
  parent,
  person,
  token,
  onDone,
  cta,
}: {
  kind: AgentKind;
  parent: string;
  person: string;
  token: string;
  onDone: () => void;
  cta: string;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState('');

  async function create() {
    const clean = label.trim().toLowerCase();
    if (clean.length < 3) { setErr('Pick a name with at least 3 characters.'); return; }
    setBusy(true); setErr(''); setStep('');
    const res = await createManagedAgent(
      { kind, label: clean, parent: parent as `0x${string}`, person: person as `0x${string}` },
      token,
      setStep,
    );
    setBusy(false);
    if (!res.ok) { setErr(res.error); return; }
    setOpen(false); setLabel('');
    onDone();
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn-ghost"
        style={{ marginTop: '.5rem', fontSize: '.8rem', padding: '.3rem .6rem' }}
        onClick={() => setOpen(true)}
      >
        {cta}
      </button>
    );
  }
  return (
    <div style={{ marginTop: '.55rem', display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
      <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="name"
          disabled={busy}
          style={{ flex: 1, padding: '.4rem .55rem', fontSize: '.85rem', border: '1px solid var(--c-g200, #e2e8f0)', borderRadius: 6 }}
        />
        <span style={{ fontSize: '.82rem', color: 'var(--c-g500, #64748b)' }}>.impact</span>
      </div>
      <div style={{ display: 'flex', gap: '.4rem' }}>
        <button type="button" className="btn-primary" style={{ fontSize: '.8rem', padding: '.35rem .7rem' }} disabled={busy} onClick={() => void create()}>
          {busy ? (step || 'Creating…') : 'Create + name'}
        </button>
        <button type="button" className="btn-ghost" style={{ fontSize: '.8rem', padding: '.35rem .7rem' }} disabled={busy} onClick={() => { setOpen(false); setErr(''); }}>
          Cancel
        </button>
      </div>
      <p className="onboarding-note" style={{ margin: 0 }}>
        Deploys an on-chain Smart Agent named <code>{(label.trim().toLowerCase() || 'name')}.impact</code>, custodied by you — one device prompt, gas sponsored.
      </p>
      {err && <p className="onboarding-hint taken" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}

function AgentRow({ a, children }: { a: { name: string; address: string; kindLabel: string }; children?: React.ReactNode }) {
  return (
    <div className="manage-card">
      <div className="manage-card-head">
        <span className="manage-card-label"><BuildingIcon size={16} /> {a.name || '(unnamed)'}</span>
        <span className="manage-card-badge live">{a.kindLabel}</span>
      </div>
      <div style={{ margin: '.45rem 0' }}><AddressChip address={a.address as `0x${string}`} size="sm" /></div>
      <p className="manage-card-blurb">
        Custodied by you. <a href={EXPLORER + a.address} target="_blank" rel="noreferrer">View on explorer ↗</a>
      </p>
      {children}
    </div>
  );
}

export function ManagedAgents({
  token,
  person,
  personName,
}: {
  token: string | null;
  person: string | null;
  personName: string | null;
}) {
  const [agents, setAgents] = useState<ManagedAgent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!token) { setLoaded(true); return; }
    let cancelled = false;
    void listManagedAgents(token)
      .then((a) => { if (!cancelled) { setAgents(a); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [token, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  if (!token || !person) return null;

  const lc = (s: string) => s.toLowerCase();
  const personTreasury = agents.find((a) => a.kind === 'person-treasury');
  const orgs = agents.filter((a) => a.kind === 'org');
  const orgTreasuryFor = (org: string) => agents.find((a) => a.kind === 'org-treasury' && lc(a.parent) === lc(org));

  return (
    <div className="dash-section" style={{ marginTop: '1.5rem' }}>
      <h2>Your agents</h2>
      <p style={{ color: 'var(--c-g500, #64748b)', fontSize: '.9rem', marginTop: '-.4rem', marginBottom: '.8rem' }}>
        Build out your tree of Smart Agents — a personal treasury, organizations, and each
        organization&rsquo;s treasury. Every agent is on-chain, named on the agent naming service, and
        custodied by you. These links are private to your home.
      </p>

      {!loaded ? (
        <p className="manage-card-blurb">Loading…</p>
      ) : (
        <div className="manage-grid">
          {/* Root — the person SA */}
          <div className="manage-card" style={{ borderColor: 'var(--c-accent, #2563eb)' }}>
            <div className="manage-card-head">
              <span className="manage-card-label"><UserIcon size={16} /> {personName || 'You'}</span>
              <span className="manage-card-badge live">You (root)</span>
            </div>
            <div style={{ margin: '.45rem 0' }}><AddressChip address={person as `0x${string}`} size="sm" /></div>
            <p className="manage-card-blurb">Your identity — every agent below is custodied by this one credential.</p>
          </div>

          {/* Personal treasury */}
          {personTreasury ? (
            <AgentRow a={{ name: personTreasury.name, address: personTreasury.agent, kindLabel: KIND_LABEL['person-treasury'] }} />
          ) : (
            <div className="manage-card">
              <div className="manage-card-head">
                <span className="manage-card-label">💳 Personal treasury</span>
                <span className="manage-card-badge">Not yet</span>
              </div>
              <p className="manage-card-blurb">A Smart Agent that holds and moves your funds, separate from your identity.</p>
              <CreateForm kind="person-treasury" parent={person} person={person} token={token} onDone={reload} cta="Create personal treasury" />
            </div>
          )}

          {/* Organizations + their treasuries */}
          {orgs.map((org) => {
            const t = orgTreasuryFor(org.agent);
            return (
              <AgentRow key={org.agent} a={{ name: org.name, address: org.agent, kindLabel: KIND_LABEL.org }}>
                <div style={{ marginTop: '.6rem', paddingTop: '.55rem', borderTop: '1px solid var(--c-g100, #eee)' }}>
                  {t ? (
                    <div style={{ fontSize: '.82rem' }}>
                      <span style={{ color: 'var(--c-g500, #64748b)' }}>Org treasury:</span>{' '}
                      <b>{t.name}</b> <AddressChip address={t.agent as `0x${string}`} size="sm" />
                    </div>
                  ) : (
                    <CreateForm kind="org-treasury" parent={org.agent} person={person} token={token} onDone={reload} cta="Create org treasury" />
                  )}
                </div>
              </AgentRow>
            );
          })}

          {/* New organization */}
          <div className="manage-card">
            <div className="manage-card-head">
              <span className="manage-card-label"><BuildingIcon size={16} /> New organization</span>
              <span className="manage-card-badge">＋</span>
            </div>
            <p className="manage-card-blurb">An organization you control — its own Smart Agent and name. Add its treasury after.</p>
            <CreateForm kind="org" parent={person} person={person} token={token} onDone={reload} cta="Create organization" />
          </div>
        </div>
      )}
    </div>
  );
}
