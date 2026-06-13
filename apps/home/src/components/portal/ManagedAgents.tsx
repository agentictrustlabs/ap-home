'use client';
// spec 275 — the member's Smart-Agent tree, split across the portal's dedicated areas:
//   /you          → PersonalTreasurySection (your personal money agent)
//   /organizations→ OrganizationsManager   (orgs + each org's treasury)
//   /treasuries   → TreasuriesRollup        (every treasury, personal + org)
// Each agent is an on-chain SA with an EXACT name, custodied by the member's ROOT credential,
// created in one gasless prompt. Links are PRIVATE vault credentials (ADR-0025), read back from
// the same /connect/related-orgs vault (MAM-D7) via listManagedAgents.
import { useEffect, useState } from 'react';
import { createPublicClient, http, formatUnits } from 'viem';
import { baseSepolia } from 'viem/chains';
import { createManagedAgent, nameManagedAgent, listManagedAgents, type AgentKind, type ManagedAgent } from '../../connect-client';
import { CONTRACTS } from '../../lib/chain';
import { AddressChip } from '../shared/AddressChip';
import { BuildingIcon, LandmarkIcon } from '../shared/Icons';

const ERC20_BALANCE_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const EXPLORER = 'https://sepolia.basescan.org/address/';
const lc = (s: string) => s.toLowerCase();

const KIND_LABEL: Record<AgentKind, string> = {
  'person-treasury': 'Personal treasury',
  org: 'Organization',
  'org-treasury': 'Org treasury',
};

/** Shared loader for the member's managed agents — one read path (MAM-D7). */
export function useManagedAgents(token: string | null) {
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
  return { agents, loaded, reload: () => setReloadKey((k) => k + 1) };
}

/** Live USDC-balance read for a treasury SA (the demo settlement asset, 6 decimals; '—' on error). */
function useUsdcBalance(address?: string): string | null {
  const [bal, setBal] = useState<string | null>(null);
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const pub = createPublicClient({ chain: baseSepolia, transport: http('/a2a/rpc') });
    pub.readContract({ address: CONTRACTS.mockUsdc, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [address as `0x${string}`] })
      .then((b) => { if (!cancelled) setBal(formatUnits(b as bigint, 6)); })
      .catch(() => { if (!cancelled) setBal(null); });
    return () => { cancelled = true; };
  }, [address]);
  return bal;
}

function BalanceLine({ address }: { address: string }) {
  const bal = useUsdcBalance(address);
  return (
    <span style={{ fontSize: '.82rem', color: 'var(--c-g500, #64748b)' }}>
      Balance: <b>{bal !== null ? `${Number(bal).toFixed(2)} USDC` : '—'}</b>
    </span>
  );
}

/** Inline "name it and create" form for one agent slot (MAM-D4 exact-name, MAM-D5 one prompt). */
export function CreateAgentForm({
  kind, parent, person, token, via, onDone, cta,
}: {
  kind: AgentKind; parent: string; person: string; token: string; via: string; onDone: () => void; cta: string;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState('');

  async function create(named: boolean) {
    const clean = label.trim().toLowerCase();
    if (named && clean.length < 3) { setErr('Pick a name with at least 3 characters, or create it unnamed.'); return; }
    setBusy(true); setErr(''); setStep('');
    const res = await createManagedAgent(
      { kind, label: named ? clean : undefined, parent: parent as `0x${string}`, person: person as `0x${string}`, via },
      token, setStep,
    );
    setBusy(false);
    if (!res.ok) { setErr(res.error); return; }
    setOpen(false); setLabel('');
    onDone();
  }

  if (!open) {
    return (
      <button type="button" className="btn-ghost" style={{ marginTop: '.5rem', fontSize: '.8rem', padding: '.3rem .6rem' }} onClick={() => setOpen(true)}>
        {cta}
      </button>
    );
  }
  return (
    <div style={{ marginTop: '.55rem', display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
      <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="name (optional)" disabled={busy}
          style={{ flex: 1, padding: '.4rem .55rem', fontSize: '.85rem', border: '1px solid var(--c-g200, #e2e8f0)', borderRadius: 6 }} />
        <span style={{ fontSize: '.82rem', color: 'var(--c-g500, #64748b)' }}>.impact</span>
      </div>
      <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
        <button type="button" className="btn-primary" style={{ fontSize: '.8rem', padding: '.35rem .7rem' }} disabled={busy} onClick={() => void create(true)}>
          {busy ? (step || 'Working…') : 'Create + name'}
        </button>
        <button type="button" className="btn-ghost" style={{ fontSize: '.8rem', padding: '.35rem .7rem' }} disabled={busy} onClick={() => void create(false)}>
          Create without a name
        </button>
        <button type="button" className="btn-ghost" style={{ fontSize: '.8rem', padding: '.35rem .7rem' }} disabled={busy} onClick={() => { setOpen(false); setErr(''); }}>
          Cancel
        </button>
      </div>
      <p className="onboarding-note" style={{ margin: 0 }}>
        Deploys an on-chain Smart Agent custodied by you — one {via === 'wallet' ? 'wallet' : 'device'} prompt, gas sponsored.
        {' '}A name is optional; you can name it later.
      </p>
      {err && <p className="onboarding-hint taken" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}

/** Claim a name for an already-deployed, NAMELESS managed agent (name-later, one gasless prompt). */
export function NameAgentForm({
  agent, kind, parent, person, token, via, onDone,
}: {
  agent: string; kind: AgentKind; parent: string; person: string; token: string; via: string; onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState('');

  async function go() {
    const clean = label.trim().toLowerCase();
    if (clean.length < 3) { setErr('Pick a name with at least 3 characters.'); return; }
    setBusy(true); setErr(''); setStep('');
    const res = await nameManagedAgent(
      { agent: agent as `0x${string}`, label: clean, kind, parent: parent as `0x${string}`, person: person as `0x${string}`, via },
      token, setStep,
    );
    setBusy(false);
    if (!res.ok) { setErr(res.error); return; }
    setOpen(false); setLabel('');
    onDone();
  }

  if (!open) {
    return (
      <button type="button" className="btn-ghost" style={{ marginTop: '.5rem', fontSize: '.78rem', padding: '.25rem .55rem' }} onClick={() => setOpen(true)}>
        Name it
      </button>
    );
  }
  return (
    <div style={{ marginTop: '.5rem', display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
      <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="name" disabled={busy}
          style={{ flex: 1, padding: '.4rem .55rem', fontSize: '.85rem', border: '1px solid var(--c-g200, #e2e8f0)', borderRadius: 6 }} />
        <span style={{ fontSize: '.82rem', color: 'var(--c-g500, #64748b)' }}>.impact</span>
      </div>
      <div style={{ display: 'flex', gap: '.4rem' }}>
        <button type="button" className="btn-primary" style={{ fontSize: '.8rem', padding: '.35rem .7rem' }} disabled={busy} onClick={() => void go()}>
          {busy ? (step || 'Naming…') : 'Name it'}
        </button>
        <button type="button" className="btn-ghost" style={{ fontSize: '.8rem', padding: '.35rem .7rem' }} disabled={busy} onClick={() => { setOpen(false); setErr(''); }}>
          Cancel
        </button>
      </div>
      {err && <p className="onboarding-hint taken" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}

/** A treasury card — name (or "unnamed" + an optional name-it slot), address, balance, explorer. */
function TreasuryCard({ name, address, sublabel, nameSlot }: { name: string; address: string; sublabel?: string; nameSlot?: React.ReactNode }) {
  return (
    <div className="manage-card">
      <div className="manage-card-head">
        <span className="manage-card-label"><LandmarkIcon size={16} /> {name || 'Unnamed treasury'}</span>
        <span className="manage-card-badge live">{sublabel ?? KIND_LABEL['person-treasury']}</span>
      </div>
      <div style={{ margin: '.45rem 0' }}><AddressChip address={address as `0x${string}`} size="sm" /></div>
      <p className="manage-card-blurb" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '.5rem' }}>
        <BalanceLine address={address} />
        <a href={EXPLORER + address} target="_blank" rel="noreferrer">explorer ↗</a>
      </p>
      {!name && nameSlot}
    </div>
  );
}

// ── /you — your personal treasury ───────────────────────────────────────
export function PersonalTreasurySection({ token, person, via }: { token: string | null; person: string | null; via: string }) {
  const { agents, loaded, reload } = useManagedAgents(token);
  if (!token || !person) return null;
  const treasury = agents.find((a) => a.kind === 'person-treasury');

  return (
    <div className="dash-section" style={{ marginTop: '1.5rem' }}>
      <h2>Your personal treasury</h2>
      <p style={{ color: 'var(--c-g500, #64748b)', fontSize: '.9rem', marginTop: '-.4rem', marginBottom: '.8rem' }}>
        A Smart Agent that holds and moves your funds, separate from your identity — on-chain, named, and
        custodied by you.
      </p>
      {!loaded ? (
        <p className="manage-card-blurb">Loading…</p>
      ) : treasury ? (
        <div className="manage-grid">
          <TreasuryCard name={treasury.name} address={treasury.agent}
            nameSlot={<NameAgentForm agent={treasury.agent} kind="person-treasury" parent={person} person={person} token={token} via={via} onDone={reload} />} />
        </div>
      ) : (
        <div className="manage-grid">
          <div className="manage-card">
            <div className="manage-card-head">
              <span className="manage-card-label"><LandmarkIcon size={16} /> Personal treasury</span>
              <span className="manage-card-badge">Not yet</span>
            </div>
            <p className="manage-card-blurb">Create your money agent — it can hold funds and pay on your behalf, while your identity stays separate.</p>
            <CreateAgentForm kind="person-treasury" parent={person} person={person} token={token} via={via} onDone={reload} cta="Create personal treasury" />
          </div>
        </div>
      )}
    </div>
  );
}

// ── /organizations — orgs + each org's treasury + create ────────────────
export function OrganizationsManager({
  token, person, via, onSelect,
}: { token: string | null; person: string | null; via: string; onSelect?: (orgAgent: string) => void }) {
  const { agents, loaded, reload } = useManagedAgents(token);
  if (!token || !person) return null;
  const orgs = agents.filter((a) => a.kind === 'org');
  const treasuryFor = (org: string) => agents.find((a) => a.kind === 'org-treasury' && lc(a.parent) === lc(org));

  return (
    <div className="dash-section">
      {!loaded ? (
        <p className="manage-card-blurb">Loading…</p>
      ) : (
        <div className="manage-grid">
          {orgs.map((org) => {
            const t = treasuryFor(org.agent);
            return (
              <div className="manage-card" key={org.agent}>
                <div className="manage-card-head">
                  <span className="manage-card-label"><BuildingIcon size={16} /> {org.name || 'Unnamed organization'}</span>
                  <span className="manage-card-badge live">{KIND_LABEL.org}</span>
                </div>
                <div style={{ margin: '.45rem 0' }}><AddressChip address={org.agent as `0x${string}`} size="sm" /></div>
                <p className="manage-card-blurb">
                  Custodied by you. <a href={EXPLORER + org.agent} target="_blank" rel="noreferrer">explorer ↗</a>
                  {onSelect && <> · <button type="button" onClick={() => onSelect(org.agent)} style={{ background: 'none', border: 'none', color: 'var(--c-accent, #2563eb)', cursor: 'pointer', padding: 0, fontSize: 'inherit' }}>view data →</button></>}
                </p>
                {!org.name && <NameAgentForm agent={org.agent} kind="org" parent={person} person={person} token={token} via={via} onDone={reload} />}
                <div style={{ marginTop: '.6rem', paddingTop: '.55rem', borderTop: '1px solid var(--c-g100, #eee)' }}>
                  {t ? (
                    <div style={{ fontSize: '.82rem', display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
                      <span style={{ color: 'var(--c-g500, #64748b)' }}><LandmarkIcon size={13} /> Treasury: <b>{t.name || 'Unnamed'}</b></span>
                      <AddressChip address={t.agent as `0x${string}`} size="sm" />
                      <BalanceLine address={t.agent} />
                      {!t.name && <NameAgentForm agent={t.agent} kind="org-treasury" parent={org.agent} person={person} token={token} via={via} onDone={reload} />}
                    </div>
                  ) : (
                    <CreateAgentForm kind="org-treasury" parent={org.agent} person={person} token={token} via={via} onDone={reload} cta="Create org treasury" />
                  )}
                </div>
              </div>
            );
          })}

          {/* New organization */}
          <div className="manage-card">
            <div className="manage-card-head">
              <span className="manage-card-label"><BuildingIcon size={16} /> New organization</span>
              <span className="manage-card-badge">＋</span>
            </div>
            <p className="manage-card-blurb">An organization you control — its own Smart Agent and name. Add its treasury after.</p>
            <CreateAgentForm kind="org" parent={person} person={person} token={token} via={via} onDone={reload} cta="Create organization" />
          </div>
        </div>
      )}
    </div>
  );
}

// ── /treasuries — every treasury, personal + org ────────────────────────
export function TreasuriesRollup({ token, person, via }: { token: string | null; person: string | null; via: string }) {
  const { agents, loaded, reload } = useManagedAgents(token);
  if (!token || !person) return null;
  const personal = agents.find((a) => a.kind === 'person-treasury');
  const orgTreasuries = agents.filter((a) => a.kind === 'org-treasury');
  const orgName = (orgAgent: string) => agents.find((a) => a.kind === 'org' && lc(a.agent) === lc(orgAgent))?.name ?? 'organization';

  return (
    <div className="dash-section">
      {!loaded ? (
        <p className="manage-card-blurb">Loading…</p>
      ) : (
        <>
          <h2 style={{ fontSize: '1rem' }}>Personal</h2>
          <div className="manage-grid">
            {personal ? (
              <TreasuryCard name={personal.name} address={personal.agent}
                nameSlot={<NameAgentForm agent={personal.agent} kind="person-treasury" parent={person} person={person} token={token} via={via} onDone={reload} />} />
            ) : (
              <div className="manage-card">
                <div className="manage-card-head">
                  <span className="manage-card-label"><LandmarkIcon size={16} /> Personal treasury</span>
                  <span className="manage-card-badge">Not yet</span>
                </div>
                <p className="manage-card-blurb">Your own money agent — holds funds and pays on your behalf.</p>
                <CreateAgentForm kind="person-treasury" parent={person} person={person} token={token} via={via} onDone={reload} cta="Create personal treasury" />
              </div>
            )}
          </div>

          <h2 style={{ fontSize: '1rem', marginTop: '1.5rem' }}>Organization treasuries</h2>
          {orgTreasuries.length === 0 ? (
            <p className="manage-card-blurb">No org treasuries yet — create one from an organization in <a href="/organizations">Organizations</a>.</p>
          ) : (
            <div className="manage-grid">
              {orgTreasuries.map((t) => (
                <TreasuryCard key={t.agent} name={t.name} address={t.agent} sublabel={`${orgName(t.parent)} treasury`}
                  nameSlot={<NameAgentForm agent={t.agent} kind="org-treasury" parent={t.parent} person={person} token={token} via={via} onDone={reload} />} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
