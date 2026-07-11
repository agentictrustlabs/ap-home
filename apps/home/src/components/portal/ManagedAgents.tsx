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
import { createManagedAgent, nameManagedAgent, fundTreasury, listManagedAgents, type AgentKind, type ManagedAgent } from '../../connect-client';
import { BusyButton } from '../shared/BusyButton';
import { emitControlEvent } from '../../home/control-plane';
import { activateVaultIfNeeded, activateInboxDeliveryIfNeeded, activateInteractionsIfNeeded, type Via } from '../../home/onboarding';
import { vaultWriteWithDelegation } from '../../lib/vault-client';
import { CONTRACTS } from '../../lib/chain';
import { AddressChip } from '../shared/AddressChip';
import { BuildingIcon, LandmarkIcon } from '../shared/Icons';
import { ConnectTreasuryModal } from './ConnectTreasuryModal';
import { ConnectedHosts } from './ConnectedHosts';

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

/** Cross-component refresh signal: EVERY `useManagedAgents` instance (topbar switcher, org lists,
 *  workspace pages) reloads when this fires — dispatch after any mutation that changes an agent's
 *  identity surface (naming, creating), so dropdowns update without a page refresh. */
export const AGENTS_CHANGED_EVENT = 'ap:agents-changed';
export const notifyAgentsChanged = (): void => { window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT)); };

/** Shared loader for the member's managed agents — one read path (MAM-D7). */
export function useManagedAgents(token: string | null) {
  const [agents, setAgents] = useState<ManagedAgent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    const bump = (): void => setReloadKey((k) => k + 1);
    window.addEventListener(AGENTS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(AGENTS_CHANGED_EVENT, bump);
  }, []);
  useEffect(() => {
    if (!token) { setLoaded(true); return; }
    let cancelled = false;
    void listManagedAgents(token)
      .then((a) => { if (!cancelled) { setAgents(a); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [token, reloadKey]);
  // `version` bumps on every reload — treasury balances re-read when it changes (e.g. after funding).
  return { agents, loaded, version: reloadKey, reload: () => setReloadKey((k) => k + 1) };
}

/** Live USDC-balance read for a treasury SA (the demo settlement asset, 6 decimals; '—' on error).
 *  `refreshKey` forces a re-read (the address is stable, so funding wouldn't otherwise refresh it). */
function useUsdcBalance(address?: string, refreshKey?: number): string | null {
  const [bal, setBal] = useState<string | null>(null);
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const pub = createPublicClient({ chain: baseSepolia, transport: http('/a2a/rpc') });
    pub.readContract({ address: CONTRACTS.mockUsdc, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [address as `0x${string}`] })
      .then((b) => { if (!cancelled) setBal(formatUnits(b as bigint, 6)); })
      .catch(() => { if (!cancelled) setBal(null); });
    return () => { cancelled = true; };
  }, [address, refreshKey]);
  return bal;
}

export function BalanceLine({ address, refreshKey }: { address: string; refreshKey?: number }) {
  const bal = useUsdcBalance(address, refreshKey);
  return (
    <span style={{ fontSize: '.82rem', color: 'var(--c-g500, #64748b)' }}>
      Balance: <b>{bal !== null ? `${Number(bal).toFixed(2)} USDC` : '—'}</b>
    </span>
  );
}

/** Fund a treasury with demo USDC (gasless mint via the home SA). On success, bumps the parent
 *  reload so the balance re-reads. */
export function FundForm({
  treasury, person, via, token, onDone,
}: {
  treasury: string; person: string; via: string; token: string; onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState('10');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState('');

  async function go() {
    const n = Number(amt);
    if (!(n > 0)) { setErr('Enter an amount greater than 0.'); return; }
    setBusy(true); setErr(''); setStep('');
    const res = await fundTreasury({ treasury: treasury as `0x${string}`, usdc: n, person: person as `0x${string}`, via }, token, setStep);
    setBusy(false);
    if (!res.ok) { setErr(res.error); return; }
    setOpen(false);
    onDone();
  }

  if (!open) {
    return (
      <button type="button" className="btn-ghost" style={{ marginTop: '.5rem', fontSize: '.78rem', padding: '.25rem .55rem' }} onClick={() => setOpen(true)}>
        Fund with USDC
      </button>
    );
  }
  return (
    <div style={{ marginTop: '.5rem', display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
      <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
        <input type="number" min="0" step="1" value={amt} onChange={(e) => setAmt(e.target.value)} disabled={busy}
          style={{ width: 90, padding: '.4rem .55rem', fontSize: '.85rem', border: '1px solid var(--c-g200, #e2e8f0)', borderRadius: 6 }} />
        <span style={{ fontSize: '.82rem', color: 'var(--c-g500, #64748b)' }}>USDC</span>
      </div>
      <div style={{ display: 'flex', gap: '.4rem' }}>
        <BusyButton busy={busy} busyLabel={step || 'Funding…'} className="btn-primary" style={{ fontSize: '.8rem', padding: '.35rem .7rem' }} onClick={() => void go()}>
          Fund
        </BusyButton>
        <button type="button" className="btn-ghost" style={{ fontSize: '.8rem', padding: '.35rem .7rem' }} disabled={busy} onClick={() => { setOpen(false); setErr(''); }}>
          Cancel
        </button>
      </div>
      <p className="onboarding-note" style={{ margin: 0 }}>Mints demo USDC to this treasury — gasless, no wallet prompt.</p>
      {err && <p className="onboarding-hint taken" style={{ margin: 0 }}>{err}</p>}
    </div>
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

  // Orgs MUST be named (counterparty-facing identity); treasuries may defer.
  const nameRequired = kind === 'org';

  async function create(named: boolean) {
    const clean = label.trim().toLowerCase();
    if (named && clean.length < 3) {
      setErr(nameRequired ? 'Organizations require a name — at least 3 characters.' : 'Pick a name with at least 3 characters, or create it unnamed.');
      return;
    }
    setBusy(true); setErr(''); setStep('');
    const res = await createManagedAgent(
      { kind, label: named ? clean : undefined, parent: parent as `0x${string}`, person: person as `0x${string}`, via },
      token, setStep,
    );
    if (!res.ok) { setBusy(false); setErr(res.error); return; }
    // spec 321 — enable channel storage AT CREATE so the steward never meets the "Enable (steward)"
    // banner: bind the org's vault key + issue its standing delivery grant (channels.data + message
    // bodies + invite tracking) signed AS THE ORG. Zero prompts on the KMS family (C_sub custodies
    // the org); device prompts on passkey/wallet. Best-effort — the steward-gated Enable button on
    // the channels page remains the recovery path if either leg fails.
    if (kind === 'org') {
      try {
        const v = via.toLowerCase() as Via;
        setStep('Enabling channel storage…');
        const bound = await activateVaultIfNeeded(res.result.agent, v, { token });
        if (!bound.ok) throw new Error(bound.error);
        const grant = await activateInboxDeliveryIfNeeded(res.result.agent, v, { token });
        if (!grant.ok) throw new Error(grant.error);
        // spec 322 W2.2 — plane-B interactions grant, same ceremony (inert until provisioned).
        const ix = await activateInteractionsIfNeeded(res.result.agent, v, { token });
        if (!ix.ok) console.warn('[org-create] interactions grant not provisioned:', ix.error);
        // spec 321 items 1+3 — seed what members will look at first: the org's profile record (the
        // "About this organization" card + roster read) and a default #general channel, so a fresh
        // org is USABLE without any steward follow-up. Best-effort, like the storage enable above.
        setStep('Setting up the organization…');
        if (res.result.stewardshipDelegation) {
          await vaultWriteWithDelegation(res.result.stewardshipDelegation, 'org.profile', { v: 1, displayName: res.result.name || clean }).catch((e) => console.warn('[org-create] org profile seed failed:', e));
        }
        await fetch('/connect/channels', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'create', communityId: res.result.agent.toLowerCase(), title: 'general' }),
        }).catch((e) => console.warn('[org-create] default channel failed:', e));
      } catch (e) {
        console.warn('[org-create] channel storage not auto-enabled (use Enable on the channels page):', e);
      }
    }
    setBusy(false);
    // Control-plane timeline (spec 310 W4): a new agent joined the member's tree.
    void emitControlEvent(token, 'agent-added', []);
    setOpen(false); setLabel('');
    notifyAgentsChanged(); // every dropdown/list instance (topbar switcher included) re-reads immediately
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
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={nameRequired ? 'name (required)' : 'name (optional)'} disabled={busy}
          style={{ flex: 1, padding: '.4rem .55rem', fontSize: '.85rem', border: '1px solid var(--c-g200, #e2e8f0)', borderRadius: 6 }} />
        <span style={{ fontSize: '.82rem', color: 'var(--c-g500, #64748b)' }}>.impact</span>
      </div>
      <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
        <BusyButton busy={busy} busyLabel={step || 'Working…'} className="btn-primary" style={{ fontSize: '.8rem', padding: '.35rem .7rem' }} onClick={() => void create(true)}>
          Create + name
        </BusyButton>
        {!nameRequired && (
          <button type="button" className="btn-ghost" style={{ fontSize: '.8rem', padding: '.35rem .7rem' }} disabled={busy} onClick={() => void create(false)}>
            Create without a name
          </button>
        )}
        <button type="button" className="btn-ghost" style={{ fontSize: '.8rem', padding: '.35rem .7rem' }} disabled={busy} onClick={() => { setOpen(false); setErr(''); }}>
          Cancel
        </button>
      </div>
      <p className="onboarding-note" style={{ margin: 0 }}>
        Deploys an on-chain Smart Agent custodied by you — one {via === 'wallet' ? 'wallet' : 'device'} prompt, gas sponsored.
        {' '}{nameRequired ? 'Organizations are counterparty-facing, so a name is required.' : 'A name is optional; you can name it later.'}
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
    notifyAgentsChanged(); // every dropdown/list instance (topbar switcher included) re-reads immediately
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
        <BusyButton busy={busy} busyLabel={step || 'Naming…'} className="btn-primary" style={{ fontSize: '.8rem', padding: '.35rem .7rem' }} onClick={() => void go()}>
          Name it
        </BusyButton>
        <button type="button" className="btn-ghost" style={{ fontSize: '.8rem', padding: '.35rem .7rem' }} disabled={busy} onClick={() => { setOpen(false); setErr(''); }}>
          Cancel
        </button>
      </div>
      {err && <p className="onboarding-hint taken" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}

/** A treasury card — name (or "unnamed" + name-it slot), address, live balance, explorer, fund action, and
 *  (for NAMED treasuries) a "Connect to hosts" popup that runs the bind → authorize → publish ceremony with
 *  the treasury already selected (spec 283/284). */
export function TreasuryCard({
  name, address, sublabel, nameSlot, person, via, token, refreshKey, onFunded,
}: {
  name: string; address: string; sublabel?: string; nameSlot?: React.ReactNode;
  person?: string | null; via?: string; token?: string | null; refreshKey?: number; onFunded?: () => void;
}) {
  const [connectOpen, setConnectOpen] = useState(false);
  return (
    <div className="manage-card">
      <div className="manage-card-head">
        <span className="manage-card-icon"><LandmarkIcon size={17} /></span>
        <span className="manage-card-label">{name || 'Unnamed treasury'}</span>
        <span className="manage-card-badge live">{sublabel ?? KIND_LABEL['person-treasury']}</span>
      </div>
      <div style={{ margin: '.45rem 0' }}><AddressChip address={address as `0x${string}`} size="sm" /></div>
      <p className="manage-card-blurb" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '.5rem' }}>
        <BalanceLine address={address} refreshKey={refreshKey} />
        <a href={EXPLORER + address} target="_blank" rel="noreferrer">explorer ↗</a>
      </p>
      {!name && nameSlot}
      <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
        {token && person && onFunded && <FundForm treasury={address} person={person} via={via ?? ''} token={token} onDone={onFunded} />}
        {name && token && (
          <button type="button" className="btn-ghost" style={{ marginTop: '.5rem', fontSize: '.78rem', padding: '.25rem .55rem' }} onClick={() => setConnectOpen(true)}>
            Connect to hosts
          </button>
        )}
      </div>
      {/* The relationship picture — shows only once the treasury has bound its A2A + MCP hosts on-chain. */}
      {name && <ConnectedHosts name={name} address={address} />}
      {connectOpen && token && (
        <ConnectTreasuryModal treasury={address} name={name} person={person} via={via} token={token}
          onClose={() => setConnectOpen(false)} onDone={onFunded} />
      )}
    </div>
  );
}

// ── /you — your personal treasury ───────────────────────────────────────
export function PersonalTreasurySection({ token, person, via }: { token: string | null; person: string | null; via: string }) {
  const { agents, loaded, version, reload } = useManagedAgents(token);
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
            person={person} via={via} token={token} refreshKey={version} onFunded={reload}
            nameSlot={<NameAgentForm agent={treasury.agent} kind="person-treasury" parent={person} person={person} token={token} via={via} onDone={reload} />} />
        </div>
      ) : (
        <div className="manage-grid">
          <div className="manage-card">
            <div className="manage-card-head">
              <span className="manage-card-icon"><LandmarkIcon size={17} /></span>
              <span className="manage-card-label">Personal treasury</span>
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
  const { agents, loaded, version, reload } = useManagedAgents(token);
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
                  <span className="manage-card-icon"><BuildingIcon size={17} /></span>
                  <span className="manage-card-label">{org.name || 'Unnamed organization'}</span>
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
                      <BalanceLine address={t.agent} refreshKey={version} />
                      {!t.name && <NameAgentForm agent={t.agent} kind="org-treasury" parent={org.agent} person={person} token={token} via={via} onDone={reload} />}
                      <FundForm treasury={t.agent} person={person} via={via} token={token} onDone={reload} />
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
              <span className="manage-card-icon"><BuildingIcon size={17} /></span>
              <span className="manage-card-label">New organization</span>
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
  const { agents, loaded, version, reload } = useManagedAgents(token);
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
          <h3 className="subhead">Personal</h3>
          <div className="manage-grid">
            {personal ? (
              <TreasuryCard name={personal.name} address={personal.agent}
                person={person} via={via} token={token} refreshKey={version} onFunded={reload}
                nameSlot={<NameAgentForm agent={personal.agent} kind="person-treasury" parent={person} person={person} token={token} via={via} onDone={reload} />} />
            ) : (
              <div className="manage-card">
                <div className="manage-card-head">
                  <span className="manage-card-icon"><LandmarkIcon size={17} /></span>
                  <span className="manage-card-label">Personal treasury</span>
                  <span className="manage-card-badge">Not yet</span>
                </div>
                <p className="manage-card-blurb">Your own money agent — holds funds and pays on your behalf.</p>
                <CreateAgentForm kind="person-treasury" parent={person} person={person} token={token} via={via} onDone={reload} cta="Create personal treasury" />
              </div>
            )}
          </div>

          <h3 className="subhead" style={{ marginTop: '1.5rem' }}>Organization treasuries</h3>
          {orgTreasuries.length === 0 ? (
            <p className="manage-card-blurb">No org treasuries yet — create one from an organization in <a href="/organizations">Organizations</a>.</p>
          ) : (
            <div className="manage-grid">
              {orgTreasuries.map((t) => (
                <TreasuryCard key={t.agent} name={t.name} address={t.agent} sublabel={`${orgName(t.parent)} treasury`}
                  person={person} via={via} token={token} refreshKey={version} onFunded={reload}
                  nameSlot={<NameAgentForm agent={t.agent} kind="org-treasury" parent={t.parent} person={person} token={token} via={via} onDone={reload} />} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
