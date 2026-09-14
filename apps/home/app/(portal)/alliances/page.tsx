'use client';
// Alliances — uupg-interop port of the GC impact home's alliances surface. An ALLIANCE is an org you
// steward whose relationship purpose contains 'alliance'; it hosts a MEMBERS ROSTER
// (impact-alliance-members, in the ALLIANCE's own vault) + a membership GROUP (urn:alliance:<sa>) —
// the collective-capability primitive. This surface is domain-agnostic: it manages "member
// organizations", never any coalition/covenant meaning (relying apps layer that on).
//
// Discovery adaptation: impact kept an in-memory session of "my orgs"; here the steward
// relationships (incl. purpose + the acting grants) live in the person-vault record
// `impact-relationships` (projected at org-create by src/home/onboarding). We read it with a signed
// person→person SELF delegation (12h, issueSiteDelegation) — one credential prompt, then every
// alliance's roster is read/written with THAT alliance's stewardship wire from the record's grants.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { signHashFor, type Via } from '../../../src/home/onboarding';
import { issueSiteDelegation, toWire, type DelegationWire } from '../../../src/lib/delegation';
import { vaultReadWithDelegation } from '../../../src/lib/vault-client';
import {
  loadAllianceMembers,
  addAllianceMember,
  ALLIANCE_MEMBERS_RECORD,
  type AllianceMember,
} from '../../../src/lib/alliance-store';
import { addToAllianceGroup, issueOrgEntitlement } from '../../../src/lib/entitlements-admin';

const EXPLORER = 'https://sepolia.basescan.org/address/';
const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

/** One entry of the person-vault `impact-relationships` projection (shape owned by the GC impact
 *  home; src/home/onboarding writes the same shape at org-create). */
interface ImpactRelationship {
  agent: Address;
  agentName?: string | null;
  kind?: string;
  relation?: string;
  purpose?: string;
  grants?: { stewardship?: DelegationWire; membership?: DelegationWire };
}
interface ImpactRelationships { v?: number; relationships?: ImpactRelationship[] }

/** Map raw vault/a2a errors to member-facing copy — the common one is a missing vault-key binding. */
function friendlyVaultError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('vault_key_unauthorized')) {
    return 'Your vault key isn’t authorized on this device yet — run the vault-key ceremony (Security → Vault key) and try again.';
  }
  return msg;
}

const inputStyle: React.CSSProperties = {
  padding: '0.5rem 0.7rem',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-8)',
  font: 'inherit',
  background: 'var(--color-surface)',
};

export default function AlliancesPage() {
  const { session, agentAddress } = useSession();
  const [rels, setRels] = useState<ImpactRelationship[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Signing a self delegation may pop the member's credential (passkey/wallet), so the read is an
  // explicit gesture — a "connect" step — rather than an unsolicited prompt on mount.
  const load = useCallback(async () => {
    if (!session || !agentAddress) return;
    setBusy(true);
    setError(null);
    try {
      const sign = await signHashFor(session.via.toLowerCase() as Via, agentAddress as Address, { token: session.token });
      const self = toWire(await issueSiteDelegation(agentAddress as Address, agentAddress as Address, sign, 12 * 3600));
      const rec = await vaultReadWithDelegation<ImpactRelationships>(self, 'impact-relationships');
      setRels((rec?.relationships ?? []).filter((r) => r && typeof r.agent === 'string'));
    } catch (e) {
      setError(friendlyVaultError(e));
    } finally {
      setBusy(false);
    }
  }, [session, agentAddress]);

  if (!session) {
    return (
      <SectionShell title="Alliances">
        <p>Not signed in.</p>
      </SectionShell>
    );
  }

  const stewarded = (rels ?? []).filter((r) => r.relation === 'steward');
  const alliances = stewarded.filter((r) => (r.purpose ?? '').includes('alliance'));
  const plainOrgs = stewarded.filter((r) => !(r.purpose ?? '').includes('alliance'));

  return (
    <SectionShell title="Alliances" description="Organizations you steward that host a membership — manage each alliance's member-organization roster.">
      {error && <p style={{ color: 'var(--color-danger)', fontSize: '.85rem' }}>{error}</p>}

      {rels === null ? (
        <div className="dash-section">
          <h2>Read your steward relationships</h2>
          <p className="manage-card-blurb">
            Your alliances live in your vault (the <code>impact-relationships</code> record, written when
            you create an org). Reading it signs a short-lived self-delegation with your credential.
          </p>
          <button className="btn-primary" style={{ width: 'auto' }} disabled={busy || !agentAddress} onClick={() => void load()}>
            {busy ? 'Signing…' : 'Read my relationships'}
          </button>
        </div>
      ) : (
        <>
          {alliances.length === 0 && (
            <div className="dash-section">
              <h2>No alliances yet</h2>
              <p className="manage-card-blurb">
                None of the organizations you steward is an alliance (an org created with an
                &lsquo;alliance&rsquo; purpose). Create one from <Link href="/agents?kind=org">Organizations</Link>{' '}
                or from a relying app, then manage its member roster here.
              </p>
            </div>
          )}

          {alliances.map((a) => (
            <AllianceCard key={a.agent} alliance={a} personSA={agentAddress as Address} />
          ))}

          {plainOrgs.length > 0 && (
            <div className="dash-section" style={{ marginTop: '1.5rem' }}>
              <h2>Other organizations you steward</h2>
              <p className="manage-card-blurb">
                These aren&apos;t alliances — they can JOIN one from the relying app (the app records the
                org→alliance membership on the org&apos;s side; the alliance admits it into the roster here).
              </p>
              {plainOrgs.map((o) => (
                <div key={o.agent} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', padding: '0.55rem 0', borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap', alignItems: 'center' }}>
                  <b>{o.agentName ?? `${o.agent.slice(0, 10)}…`}</b>
                  <a href={`${EXPLORER}${o.agent}`} target="_blank" rel="noreferrer" style={{ fontSize: '.8rem', color: 'var(--color-text-muted)' }}>
                    {o.agent.slice(0, 10)}…{o.agent.slice(-6)} · explorer ↗
                  </a>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </SectionShell>
  );
}

// ── One alliance: roster + admit-a-member (the impact 3-step: roster → group → entitlement) ───────
function AllianceCard({ alliance, personSA }: { alliance: ImpactRelationship; personSA: Address }) {
  const stewardship = alliance.grants?.stewardship ?? null;
  const allianceSA = alliance.agent;
  const display = alliance.agentName ?? `${allianceSA.slice(0, 10)}…`;

  const [members, setMembers] = useState<AllianceMember[] | null>(null);
  const [rosterErr, setRosterErr] = useState<string | null>(null);
  const [addr, setAddr] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!stewardship) return;
    try {
      setMembers(await loadAllianceMembers(stewardship));
      setRosterErr(null);
    } catch (e) {
      // A fresh alliance has no record yet — demo-mcp reports that as a failed read; treat it as empty
      // unless it's the actionable vault-key case.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('vault_key_unauthorized')) setRosterErr(friendlyVaultError(e));
      setMembers([]);
    }
    // The wire is stable for the record's lifetime — key the roster load on the alliance SA.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allianceSA]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function onAdd() {
    if (!stewardship) return;
    setErr(null);
    const sa = addr.trim() as Address;
    if (!isAddr(sa)) { setErr('Enter a valid organization address (0x…).'); return; }
    if (sa.toLowerCase() === allianceSA.toLowerCase()) { setErr("An alliance can't add itself."); return; }
    const label = name.trim() || `org ${sa.slice(0, 8)}`;
    const auth = { stewardship, requester: personSA };
    try {
      // 1. Add to the alliance's members roster (its own vault, over its stewardship wire).
      setBusy('Adding to the members roster…');
      const now = Math.floor(Date.now() / 1000);
      const next = await addAllianceMember(stewardship, { sa, name: label }, now);
      // 2. Add to the membership group — the collective-capability grant.
      setBusy('Conferring membership (group)…');
      const g = await addToAllianceGroup(auth, allianceSA, sa);
      if (!g.ok) throw new Error(g.error);
      // 3. Best-effort: entitle the member to read the roster (the group grant already confers the
      //    collective capability; the roster entitlement is additive).
      try {
        await issueOrgEntitlement(auth, { member: sa, recordType: ALLIANCE_MEMBERS_RECORD, purpose: 'alliance-membership' });
      } catch { /* additive — never fail the admit */ }
      setMembers(next);
      setAddr(''); setName(''); setBusy(null);
    } catch (e) {
      setBusy(null);
      setErr(friendlyVaultError(e));
    }
  }

  return (
    <div className="dash-section" style={{ marginTop: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>{display} <span className="manage-card-badge live" style={{ marginLeft: '0.4rem' }}>alliance</span></h2>
        <a href={`${EXPLORER}${allianceSA}`} target="_blank" rel="noreferrer" style={{ fontSize: '.8rem', color: 'var(--color-text-muted)' }}>
          {allianceSA.slice(0, 10)}…{allianceSA.slice(-6)} · explorer ↗
        </a>
      </div>

      {!stewardship ? (
        <p className="manage-card-blurb" style={{ marginTop: '0.5rem' }}>
          This relationship record carries no stewardship grant, so the roster can&apos;t be managed from
          here — reopen the alliance from the app that created it to refresh the record.
        </p>
      ) : (
        <>
          <div style={{ margin: '0.8rem 0' }}>
            <b style={{ fontSize: '.92rem' }}>Add a member organization</b>
            <p className="manage-card-blurb" style={{ margin: '0.2rem 0 0.6rem' }}>
              By its agent address. It joins the roster and the membership group — no service holds its key.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                placeholder="Organization address 0x…"
                aria-label="Organization address"
                style={{ ...inputStyle, flex: 1, minWidth: 240, fontFamily: 'var(--font-mono, monospace)' }}
              />
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Display name"
                aria-label="Display name"
                style={{ ...inputStyle, width: 170 }}
              />
              <button className="btn-primary" style={{ width: 'auto' }} onClick={() => void onAdd()} disabled={!!busy}>
                {busy ?? 'Add member'}
              </button>
            </div>
            {err && <p style={{ color: 'var(--color-danger)', fontSize: '.85rem', margin: '0.5rem 0 0' }}>{err}</p>}
          </div>

          <b style={{ fontSize: '.92rem' }}>Member organizations</b>
          {rosterErr && <p style={{ color: 'var(--color-danger)', fontSize: '.85rem', margin: '0.4rem 0 0' }}>{rosterErr}</p>}
          {members === null && !rosterErr && <p className="manage-card-blurb" style={{ margin: '0.4rem 0 0' }}>Loading members…</p>}
          {members !== null && members.length === 0 && !rosterErr && (
            <p className="manage-card-blurb" style={{ margin: '0.4rem 0 0' }}>No member organizations yet — add one by its address above.</p>
          )}
          {members !== null && members.length > 0 && members.map((m) => (
            <div key={m.sa} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', padding: '0.55rem 0', borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap', alignItems: 'center' }}>
              <div>
                <b>{m.name}</b> <span className="manage-card-badge live" style={{ marginLeft: '0.4rem' }}>member</span>
              </div>
              <a href={`${EXPLORER}${m.sa}`} target="_blank" rel="noreferrer" style={{ fontSize: '.8rem', color: 'var(--color-text-muted)' }}>
                {m.sa.slice(0, 10)}…{m.sa.slice(-6)} · explorer ↗
              </a>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
