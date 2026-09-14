'use client';
// spec 275 — the member's Smart-Agent tree, split across the portal's dedicated areas:
//   /organizations→ OrganizationsManager   (orgs + each org's treasury)
//   /treasuries   → TreasuriesRollup        (every treasury, personal + org)
// Each agent is an on-chain SA with an EXACT name, custodied by the member's ROOT credential,
// created in one gasless prompt. Links are PRIVATE vault credentials (ADR-0025), read back from
// the same /connect/related-orgs vault (MAM-D7) via listManagedAgents.
import { useEffect, useState } from 'react';
import { ExplorerLink } from '../shared/ExplorerLink';
import { FleetLines } from './FleetLines';
import { fundThroughHarness } from '../../home/fund-harness';
import { createPublicClient, http, formatUnits } from 'viem';
import { baseSepolia } from 'viem/chains';
import { AGENT_NAME_PARENT } from '../../lib/domain';
import { typedTldForKind, createManagedAgent, nameManagedAgent, personSignHash, listManagedAgents, invalidateRelatedOrgs, signsWithoutPrompt, type AgentKind, type ManagedAgent, type CreateManagedAgentResult } from '../../connect-client';
import { BusyButton } from '../shared/BusyButton';
import { PrimaryPayee } from './PrimaryPayee';
import { assignDefaultArchetype } from '../../home/default-archetype';
import { emitControlEvent } from '../../home/control-plane';
import { activateVaultIfNeeded, activateInboxDeliveryIfNeeded, activateInteractionsIfNeeded, signHashFor, type Via } from '../../home/onboarding';
import { setOrgLifecycleStatus } from '../../home/org-lifecycle';
import { orgStatusOf, STATUS_LABEL, type OrgSurface } from '../../lib/org-lifecycle';
import type { DelegationWire } from '../../lib/delegation';
import { vaultWriteWithDelegation } from '../../lib/vault-client';
import { COINS, shown, type Coin } from '../../lib/coins';
import { CONTRACTS } from '../../lib/chain';
import { AddressChip } from '../shared/AddressChip';
import { BuildingIcon, LandmarkIcon } from '../shared/Icons';
import { ConnectTreasuryModal } from './ConnectTreasuryModal';
import { ConnectedHosts } from './ConnectedHosts';
import { agentClassOf, orgKindWordOf, creatableKinds, type CreatableKind } from '../../lib/agent-class';
import { BasisLine } from './BasisLine';

const ERC20_BALANCE_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const lc = (s: string) => s.toLowerCase();

const KIND_LABEL: Record<AgentKind, string> = {
  'person-treasury': 'Personal treasury',
  org: 'Organization',
  team: 'Team',
  circle: 'Circle',
  church: 'Church',
  household: 'Household',
  'org-treasury': 'Org treasury',
  service: 'Service agent',
  workspace: 'App workspace',
};

/** Cross-component refresh signal: EVERY `useManagedAgents` instance (topbar switcher, org lists,
 *  workspace pages) reloads when this fires — dispatch after any mutation that changes an agent's
 *  identity surface (naming, creating), so dropdowns update without a page refresh. */
export const AGENTS_CHANGED_EVENT = 'ap:agents-changed';
export const notifyAgentsChanged = (): void => {
  // Any writer that announces a change also drops the shared `/connect/related-orgs` payload, so a
  // caller outside connect-client (org lifecycle, enrolment, discussions) can't be served a stale list.
  invalidateRelatedOrgs();
  window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));
};

/** Shared loader for the member's managed agents — one read path (MAM-D7).
 *
 *  spec 342 — `surface` decides which lifecycle states come back, and the DEFAULT IS THE NARROW
 *  ONE: a screen that never heard of the spec shows only active organizations (and drops the
 *  treasuries hanging off hidden ones). Pass 'roster' for the organizations list, which must show
 *  inactive orgs so they can be reactivated, and 'any' for a page addressed by a specific SA. */
export function useManagedAgents(token: string | null, surface: OrgSurface = 'working') {
  const [agents, setAgents] = useState<ManagedAgent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    const bump = (): void => { invalidateRelatedOrgs(); setReloadKey((k) => k + 1); };
    window.addEventListener(AGENTS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(AGENTS_CHANGED_EVENT, bump);
  }, []);
  useEffect(() => {
    if (!token) { setLoaded(true); return; }
    let cancelled = false;
    void listManagedAgents(token, surface)
      .then((a) => { if (!cancelled) { setAgents(a); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [token, reloadKey, surface]);
  // `version` bumps on every reload — treasury balances re-read when it changes (e.g. after funding).
  return { agents, loaded, version: reloadKey, reload: () => setReloadKey((k) => k + 1) };
}

/** Live balance read for a treasury SA, for EVERY coin this Home knows about (`lib/coins.ts`).
 *
 *  It read exactly one — the demo USDC — and printed the answer as "Balance: N USDC", which is not
 *  the balance of the account but the balance of one asset in it. A treasury holding ten thousand
 *  Sheqels of a relying app's currency read "0.00 USDC" here, and its owner reasonably concluded the
 *  money was gone. All the coins are read at once; one that fails costs its own row and no other.
 *
 *  `refreshKey` forces a re-read (the address is stable, so funding wouldn't otherwise refresh it). */
function useCoinBalances(address?: string, refreshKey?: number): { coin: Coin; amount: bigint | null }[] {
  const [bals, setBals] = useState<{ coin: Coin; amount: bigint | null }[]>(() => COINS.map((coin) => ({ coin, amount: null })));
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const pub = createPublicClient({ chain: baseSepolia, transport: http('/a2a/rpc') });
    void Promise.all(
      COINS.map(async (coin) => {
        try {
          const b = await pub.readContract({ address: coin.address, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [address as `0x${string}`] });
          return { coin, amount: b as bigint };
        } catch {
          return { coin, amount: null };
        }
      }),
    ).then((got) => { if (!cancelled) setBals(got); });
    return () => { cancelled = true; };
  }, [address, refreshKey]);
  return bals;
}

export function BalanceLine({ address, refreshKey }: { address: string; refreshKey?: number }) {
  const bals = useCoinBalances(address, refreshKey);
  const rows = shown(bals);
  return (
    <span style={{ fontSize: '.82rem', color: 'var(--c-g500, #64748b)' }}>
      Balance:{' '}
      {rows.map((b, i) => (
        <span key={b.coin.address}>
          {i > 0 ? ' · ' : ''}
          <b>{b.amount !== null ? `${Number(formatUnits(b.amount, b.coin.decimals)).toFixed(2)} ${b.coin.symbol}` : '—'}</b>
        </span>
      ))}
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
  // Whether THIS session signs without a device prompt. `null` until known — the note says nothing rather
  // than guessing, because guessing is how it came to promise "no wallet prompt" to a wallet home.
  const [promptless, setPromptless] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void signsWithoutPrompt(via, token).then((v) => { if (live) setPromptless(v); }).catch(() => { if (live) setPromptless(null); });
    return () => { live = false; };
  }, [via, token]);

  async function go() {
    const n = Number(amt);
    if (!(n > 0)) { setErr('Enter an amount greater than 0.'); return; }
    setBusy(true); setErr(''); setStep('');
    // Through the HARNESS (spec 361 I4): this button and "fund my treasury with N usdc" are one
    // implementation now. Same one signature (the mandate replaces the direct userOp sign), and the
    // converged path fires the spec-360 FundingReceipt the direct mint never left.
    setStep('Granting the funding authority…');
    const sign = await personSignHash(person as `0x${string}`, via, token);
    if (typeof sign !== 'function') { setBusy(false); setErr(sign.error); return; }
    // Whole USDC → the 6-decimal atomic figure the rail now takes for every coin. Same number the
    // caller used to hand over; the conversion just moved to the one place that knows the decimals.
    const res = await fundThroughHarness({
      treasury: treasury as `0x${string}`,
      amount: BigInt(Math.round(n * 1_000_000)),
      display: `${n} usdc`,
      session: { token },
      signHash: sign,
    });
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
      <BasisLine needs="a transfer from your own balance to this treasury — your credential signs the userOp" />
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
      {/* Say what THIS session will actually do. "no wallet prompt" was written for KMS homes and read as
          a promise by everyone: a wallet home signs the mint with its own credential, and a seeded demo
          person signs at the Home. Gas is sponsored either way; the signature is not always free. */}
      <p className="onboarding-note" style={{ margin: 0 }}>
        Mints demo USDC to this treasury — gas is sponsored.{' '}
        {promptless === null ? '' : promptless ? 'Your home signs it: no wallet prompt.' : 'Your wallet will ask you to sign it.'}
      </p>
      {err && <p className="onboarding-hint taken" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}

/**
 * Charter one managed agent AND everything it is born with — the create ceremony itself, the
 * storage an organization needs before its first member arrives, the playbook the effect resolver
 * reads off the payer, and the member's own timeline entry — in one call that RETURNS THE AGENT.
 *
 * This was the body of `CreateAgentForm.create`, and it is a function now because the form is no
 * longer the only surface that charters an agent. The treasury ceremony (`app/choose-treasury`)
 * creates a person treasury on behalf of an app that asked for one, and it has to hand that
 * treasury's ADDRESS straight back to the app — which a form whose only output is `onDone()`
 * cannot do. Copying the sequence over there would have left four best-effort steps free to drift
 * apart: a treasury born without the playbook that makes it say what it paid, a hole in the
 * timeline, an org with no channel storage. One implementation, two callers, and the result comes
 * back.
 *
 * Everything after the create itself is BEST-EFFORT on purpose. None of it grants anything, and a
 * person's new agent must not fail to exist because a courtesy failed.
 */
export async function createAgentWithBirthrights(
  input: { kind: AgentKind; label?: string; parent: string; person: string; via: string },
  token: string,
  onStep: (s: string) => void,
): Promise<{ ok: true; result: CreateManagedAgentResult } | { ok: false; error: string }> {
  const { kind, label, parent, person, via } = input;
  const res = await createManagedAgent(
    { kind, label, parent: parent as `0x${string}`, person: person as `0x${string}`, via },
    token, onStep,
  );
  if (!res.ok) return res;
  // spec 321 — enable channel storage AT CREATE so the steward never meets the "Enable (steward)"
  // banner: bind the org's vault key + issue its standing delivery grant (channels.data + message
  // bodies + invite tracking) signed AS THE ORG. Zero prompts on the KMS family (C_sub custodies
  // the org); device prompts on passkey/wallet. Best-effort — the steward-gated Enable button on
  // the channels page remains the recovery path if either leg fails.
  if (kind === 'org') {
    try {
      const v = via.toLowerCase() as Via;
      onStep('Enabling channel storage…');
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
      onStep('Setting up the organization…');
      if (res.result.stewardshipDelegation) {
        await vaultWriteWithDelegation(res.result.stewardshipDelegation, 'org.profile', { v: 1, displayName: res.result.name || label || '' }).catch((e) => console.warn('[org-create] org profile seed failed:', e));
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
  // THE PLAYBOOK IT IS BORN WITH (spec 354 §3). A treasury with no assignment runs the bare harness —
  // which is a documented state, except that the spec-360 effect resolver reads the PAYER's playbook,
  // so an unassigned treasury moves money and tells nobody.
  const born = await assignDefaultArchetype(res.result.agent, kind, token);
  if (!born.ok) console.warn(`[agent-create] no default playbook for ${kind}:`, born.reason);
  // Control-plane timeline (spec 310 W4): a new agent joined the member's tree.
  void emitControlEvent(token, 'agent-added', []);
  notifyAgentsChanged(); // every dropdown/list instance (topbar switcher included) re-reads immediately
  return res;
}

/** Inline "name it and create" form for one agent slot (MAM-D4 exact-name, MAM-D5 one prompt).
 *
 *  `choices` turns the single-slot form into a chartering form: the person picks WHAT to create, and the
 *  suffix beside the name field is the one that kind will actually claim. The list is filtered to the
 *  typed roots this chain has provisioned, so it never offers a kind whose name would fail to claim. */
export function CreateAgentForm({
  kind: fixedKind, choices, parent, person, token, via, onDone, cta,
}: {
  kind?: AgentKind; choices?: CreatableKind[]; parent: string; person: string; token: string; via: string; onDone: () => void; cta: string;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState<AgentKind | null>(null);

  const kind: AgentKind = picked ?? fixedKind ?? choices?.[0]?.kind ?? 'org';
  const choice = choices?.find((c) => c.kind === kind);
  // Counterparty-facing agents MUST be named — an organization, a team, a service others will address.
  // Plumbing (a treasury) may defer. The table says which; a single-kind form keeps the old rule.
  const nameRequired = choice ? choice.nameRequired : kind === 'org';

  async function create(named: boolean) {
    const clean = label.trim().toLowerCase();
    if (named && clean.length < 3) {
      setErr(nameRequired ? 'Organizations require a name — at least 3 characters.' : 'Pick a name with at least 3 characters, or create it unnamed.');
      return;
    }
    setBusy(true); setErr(''); setStep('');
    const res = await createAgentWithBirthrights(
      { kind, label: named ? clean : undefined, parent, person, via }, token, setStep,
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
      {choices && choices.length > 1 && (
        <label style={{ display: 'flex', gap: '.4rem', alignItems: 'center', fontSize: '.82rem' }}>
          <span style={{ color: 'var(--c-g500, #64748b)' }}>Create</span>
          <select
            value={kind} disabled={busy} onChange={(e) => { setPicked(e.target.value as AgentKind); setErr(''); }}
            data-testid="create-kind"
            style={{ flex: 1, padding: '.35rem .5rem', fontSize: '.85rem', border: '1px solid var(--c-g200, #e2e8f0)', borderRadius: 6 }}
          >
            {choices.map((c) => (
              <option key={c.kind} value={c.kind}>{c.label} · .{typedTldForKind(c.kind)?.tld ?? AGENT_NAME_PARENT}</option>
            ))}
          </select>
        </label>
      )}
      <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={nameRequired ? 'name (required)' : 'name (optional)'} disabled={busy}
          style={{ flex: 1, padding: '.4rem .55rem', fontSize: '.85rem', border: '1px solid var(--c-g200, #e2e8f0)', borderRadius: 6 }} />
        {/* The suffix this agent will ACTUALLY be named under. It was hardcoded `.impact` — the legacy
            root — while the claim already used the typed one for the kind (`typedTldForKind`), so the
            form promised `.impact` and produced `.org`. Worse than cosmetic: the suffix names the derived
            TYPE (spec 346), and `.impact` carries none, so the label said "this will not be listable"
            about an agent that would be. */}
        <span style={{ fontSize: '.82rem', color: 'var(--c-g500, #64748b)' }}>.{typedTldForKind(kind)?.tld ?? AGENT_NAME_PARENT}</span>
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
        {' '}{choice?.blurb ? `${choice.blurb} ` : ''}{nameRequired ? 'It is counterparty-facing, so a name is required.' : 'A name is optional; you can name it later.'}
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
        {/* The suffix this agent will ACTUALLY be named under. It was hardcoded `.impact` — the legacy
            root — while the claim already used the typed one for the kind (`typedTldForKind`), so the
            form promised `.impact` and produced `.org`. Worse than cosmetic: the suffix names the derived
            TYPE (spec 346), and `.impact` carries none, so the label said "this will not be listable"
            about an agent that would be. */}
        <span style={{ fontSize: '.82rem', color: 'var(--c-g500, #64748b)' }}>.{typedTldForKind(kind)?.tld ?? AGENT_NAME_PARENT}</span>
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
        <ExplorerLink address={address} label="explorer ↗" />
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
/** spec 342 — the one place an inactive org is shown, so it is the one place it can be brought
 *  back. Writes the org's own `org.lifecycle` record over the stewardship delegation the tree row
 *  already carries; without that delegation there is nothing to present, so the row says so
 *  instead of offering a button that would 403. */
function ActivateOrgRow({ org, person, token, onDone }: {
  org: ManagedAgent; person: string; token: string; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stewardship = org.stewardshipDelegation as DelegationWire | undefined;

  return (
    <div style={{ marginTop: '.5rem', padding: '.55rem .65rem', borderRadius: 8, background: 'var(--color-amber-50, #fffbeb)' }}>
      <p className="manage-card-blurb" style={{ margin: '0 0 .45rem', fontSize: '.78rem' }}>
        Deactivated — hidden everywhere else in your home.
      </p>
      {stewardship ? (
        <BusyButton
          busy={busy}
          busyLabel="Activating…"
          className="btn-ghost"
          style={{ fontSize: '.78rem', padding: '.25rem .55rem' }}
          onClick={() => {
            setBusy(true);
            setErr(null);
            void setOrgLifecycleStatus({
              person: person as `0x${string}`,
              org: org.agent,
              token,
              stewardship,
              status: 'active',
            }).then((r) => {
              setBusy(false);
              if (!r.ok) { setErr(r.error); return; }
              notifyAgentsChanged();
              onDone();
            });
          }}
        >
          Activate
        </BusyButton>
      ) : (
        <p className="manage-card-blurb" style={{ margin: 0, fontSize: '.75rem' }}>
          You hold no stewardship delegation on this organization, so only a steward can activate it.
        </p>
      )}
      {err && <p className="manage-card-blurb" style={{ margin: '.35rem 0 0', fontSize: '.75rem', color: 'var(--c-danger, #dc2626)' }}>{err}</p>}
    </div>
  );
}

// ── /organizations — orgs + each org's treasury + create ────────────────
export function OrganizationsManager({
  token, person, via, onSelect, initialFilter = 'all',
}: { token: string | null; person: string | null; via: string; onSelect?: (orgAgent: string) => void; initialFilter?: 'all' | 'org' | 'service' }) {
  // 'roster' (spec 342): this list shows deactivated orgs — it is the route back to activating them.
  const { agents, loaded, version, reload } = useManagedAgents(token, 'roster');
  const [filter, setFilter] = useState<'all' | 'org' | 'service'>(initialFilter);
  if (!token || !person) return null;
  // ADR-0046 — the CLASS is the trichotomy (a team is an organization, a treasury is a service); the row
  // says which SUBCLASS it is. The filter groups by class because that is the distinction the substrate
  // makes; it never invents a third category to hold the things that did not fit.
  const orgs = agents.filter((a) => agentClassOf(a.kind) === 'org');
  // A treasury is shown INSIDE the organization it belongs to, so it would read twice here.
  const services = agents.filter((a) => agentClassOf(a.kind) === 'service' && a.kind !== 'org-treasury');
  const treasuryFor = (org: string) => agents.find((a) => a.kind === 'org-treasury' && lc(a.parent) === lc(org));
  const claimable = (k: AgentKind) => !!typedTldForKind(k);
  const showOrgs = filter !== 'service';
  const showServices = filter !== 'org';
  // The filter NARROWS a page that already shows its own structure — it is not the structure. With
  // everything shown, the two classes read as headed sections; picking one hides the other rather than
  // rearranging the page under you.
  const Filter = () => (
    <div className="ui-toolbar">
      <div className="ui-tabs" role="tablist" aria-label="Filter the agents you steward">
        {([['all', 'All', orgs.length + services.length], ['org', 'Organizations', orgs.length], ['service', 'Services', services.length]] as const).map(([v, l, n]) => (
          <button key={v} type="button" role="tab" aria-selected={filter === v} onClick={() => setFilter(v)} data-testid={`steward-filter-${v}`} className="ui-tab">{l}<span className="ui-count">{n}</span></button>
        ))}
      </div>
    </div>
  );
  const Heading = ({ children, n }: { children: React.ReactNode; n?: number }) => (
    <div className="ui-section-head" style={{ gridColumn: '1 / -1', marginTop: 'var(--sp-3)' }}><h2>{children}{typeof n === 'number' && <span className="ui-count">{n}</span>}</h2></div>
  );

  return (
    <div className="dash-section">
      {!loaded ? (
        <p className="manage-card-blurb">Loading…</p>
      ) : (
        <>
        <Filter />
        <div className="manage-grid">
          {showOrgs && orgs.length > 0 && <Heading n={orgs.length}>Organizations</Heading>}
          {showOrgs && orgs.map((org) => {
            const t = treasuryFor(org.agent);
            const inactive = orgStatusOf(org) === 'inactive';
            return (
              <div className="manage-card" key={org.agent} style={inactive ? { opacity: 0.72 } : undefined}>
                <div className="manage-card-head">
                  <span className="manage-card-icon"><BuildingIcon size={17} /></span>
                  <span className="manage-card-label">{org.name || 'Unnamed organization'}</span>
                  <span className={`manage-card-badge${inactive ? '' : ' live'}`}>
                    {/* The subclass word (team / circle / church), not the class — a church is an organization, and says which. */}
                    {inactive ? STATUS_LABEL.inactive : orgKindWordOf(org.kind).replace(/^./, (c) => c.toUpperCase())}
                  </span>
                </div>
                <div style={{ margin: '.45rem 0' }}><AddressChip address={org.agent as `0x${string}`} size="sm" /></div>
                <p className="manage-card-blurb">
                  Custodied by you. <ExplorerLink address={org.agent} label="explorer ↗" />
                  {onSelect && <> · <button type="button" onClick={() => onSelect(org.agent)} style={{ background: 'none', border: 'none', color: 'var(--color-amber-700)', cursor: 'pointer', padding: 0, minHeight: 0, fontSize: 'inherit' }}>view data →</button></>}
                </p>
                {!org.name && <NameAgentForm agent={org.agent} kind="org" parent={person} person={person} token={token} via={via} onDone={reload} />}
                {inactive && <ActivateOrgRow org={org} person={person} token={token} onDone={reload} />}
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
                {/* Charter INSIDE this organization — a team, a workspace, a service. The parent is the org,
                    so the child's stewardship grant points at it and its typed name lands under the org's
                    authority. Chartering was only possible from the person's own realm before, which made a
                    team under an organization something you could ask for but not click. */}
                <div style={{ marginTop: '.5rem', paddingTop: '.5rem', borderTop: '1px solid var(--c-g100, #eee)' }}>
                  <CreateAgentForm
                    choices={creatableKinds('org', claimable).filter((c) => c.kind !== 'org-treasury')}
                    parent={org.agent} person={person} token={token} via={via} onDone={reload} cta="Charter inside this organization"
                  />
                </div>
              </div>
            );
          })}

          {/* Every service-class agent you steward — a workspace, a registry, a plain `.svc` service. They
              were invisible here: this page listed org-class agents only, so a service you had chartered
              existed, resolved, and appeared nowhere you could act on it. */}
          {showServices && services.length > 0 && <Heading n={services.length}>Services</Heading>}
          {showServices && services.map((svc) => (
            <div className="manage-card" key={svc.agent}>
              <div className="manage-card-head">
                <span className="manage-card-icon"><LandmarkIcon size={17} /></span>
                <span className="manage-card-label">{svc.name || 'Unnamed service agent'}</span>
                <span className="manage-card-badge live">{KIND_LABEL[svc.kind]}</span>
              </div>
              <div style={{ margin: '.45rem 0' }}><AddressChip address={svc.agent as `0x${string}`} size="sm" /></div>
              <p className="manage-card-blurb">Custodied by you. <ExplorerLink address={svc.agent} label="explorer ↗" /></p>
              {/* M06 (398 §4.4) — the fleet boundary on the services roster too: runs at · may spend · holds. */}
              <FleetLines agent={svc.agent as `0x${string}`} token={token} stewardship />
              {!svc.name && <NameAgentForm agent={svc.agent} kind={svc.kind} parent={svc.parent} person={person} token={token} via={via} onDone={reload} />}
            </div>
          ))}

          {/* Charter something new — the kind picker offers every typed root THIS chain has provisioned. */}
          <Heading>Charter a new agent</Heading>
          <div className="manage-card">
            <div className="manage-card-head">
              <span className="manage-card-icon"><BuildingIcon size={17} /></span>
              <span className="manage-card-label">New agent</span>
              <span className="manage-card-badge">new</span>
            </div>
            <p className="manage-card-blurb">An organization, team, workspace or service you control — its own Smart Agent and typed name.</p>
            <CreateAgentForm choices={creatableKinds('person', claimable)} parent={person} person={person} token={token} via={via} onDone={reload} cta="Create agent" />
          </div>
        </div>
        </>
      )}
    </div>
  );
}

// ── /treasuries — every treasury, personal + org ────────────────────────
export function TreasuriesRollup({ token, person, via }: { token: string | null; person: string | null; via: string }) {
  const { agents, loaded, version, reload } = useManagedAgents(token);
  if (!token || !person) return null;
  // ALL of them. A person may hold several — the Ask can charter one in a sentence, and creating
  // alice3.treasury while alice2.treasury existed made the new one vanish from the page that is supposed
  // to list it. Org treasuries were always a list here; personal ones were a single `find`.
  const personal = agents.filter((a) => a.kind === 'person-treasury');
  const orgTreasuries = agents.filter((a) => a.kind === 'org-treasury');
  const orgName = (orgAgent: string) => agents.find((a) => agentClassOf(a.kind) === 'org' && lc(a.agent) === lc(orgAgent))?.name ?? 'organization';

  return (
    <div className="dash-section">
      {!loaded ? (
        <p className="manage-card-blurb">Loading…</p>
      ) : (
        <>
          <div className="ui-section-head"><h2>Personal<span className="ui-count">{personal.length}</span></h2></div>
          <div className="manage-grid">
            {personal.length ? (
              personal.map((t) => (
                <TreasuryCard key={t.agent} name={t.name} address={t.agent}
                  person={person} via={via} token={token} refreshKey={version} onFunded={reload}
                  nameSlot={
                    <>
                      <NameAgentForm agent={t.agent} kind="person-treasury" parent={person} person={person} token={token} via={via} onDone={reload} />
                      {/* WHICH ONE RECEIVES. Holding several is ordinary; only you know which is the one
                          to be paid into, and saying so spares every payer a question about your accounts. */}
                      <PrimaryPayee
                        treasury={t.agent} person={person} token={token}
                        signHash={async (d) => (await signHashFor(via as Via, person as `0x${string}`, { token }))(d)}
                      />
                    </>
                  } />
              ))
            ) : null}
            {/* ALWAYS offered, not only when there are none. Holding one treasury is not a reason to be
                unable to make another: a second is how you separate what is yours from what you are
                holding for something, and an UNNAMED one is how you keep a payment address off the
                public record entirely (spec 338). The card used to appear only in the empty state, so a
                person with one treasury had no way to make a second from the page that lists them. */}
            <div className="manage-card">
              <div className="manage-card-head">
                <span className="manage-card-icon"><LandmarkIcon size={17} /></span>
                <span className="manage-card-label">{personal.length ? 'Another personal treasury' : 'Personal treasury'}</span>
                <span className="manage-card-badge">{personal.length ? 'Optional' : 'Not yet'}</span>
              </div>
              <p className="manage-card-blurb">
                Your own money agent — holds funds and pays on your behalf.
                {' '}An unnamed one is not in the public directory: someone can only pay it if you give them a way to find it.
              </p>
              <CreateAgentForm kind="person-treasury" parent={person} person={person} token={token} via={via} onDone={reload} cta={personal.length ? 'Create another treasury' : 'Create personal treasury'} />
            </div>
          </div>

          <div className="ui-section-head" style={{ marginTop: 'var(--sp-6)' }}><h2>Organization treasuries</h2></div>
          {orgTreasuries.length === 0 ? (
            <p className="manage-card-blurb">No org treasuries yet — create one from an organization in <a href="/agents">Agents</a>.</p>
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
