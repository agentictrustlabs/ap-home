'use client';
// Agent Naming Service (spec 280). Manage the names you steward and publish the OPT-IN, owner-authorized,
// PUBLIC connection-bootstrap record (kind + optional pre-select address) so a returning person on a fresh
// device can discover how to connect to your Smart Agent by name. Publishing is always an explicit action
// here (never automatic); the address toggle is clearly labeled "public" because the bootstrap read is a
// public directory lookup by necessity (ADR-0040 amendment). Owner-signed, gasless — one custody prompt.
// Styling uses the shared inline theme (src/components/portal/theme.ts) — same amber tokens as the
// rest of the portal.
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { AgentNamingEditor } from '../../../src/components/portal/discovery/AgentNamingEditor';
import { ChangeNameCard } from '../../../src/components/portal/naming/ChangeNameCard';
import { TownDoneNote, TownHandoffNote, finishTownHandoff, useTownHandoff, useTownReturn } from '../../../src/components/portal/naming/TownHandoff';
import { PurchaseNameCard } from '../../../src/components/portal/naming/PurchaseNameCard';
import { isPricedTld } from '../../../src/lib/naming-price';
import { loadRegistry, markCustody, type AgentRegistryRow } from '../../../src/lib/registry';
import { setConnectionInfo, resolveCredential, claimName, fetchProfile } from '../../../src/connect-client';
import { notifyAgentsChanged } from '../../../src/components/portal/ManagedAgents';
import { signHashFor, resolveVia, type Via } from '../../../src/home/onboarding';
import { nameLabel, CONNECT_DOMAIN, NEW_PERSON_TLD } from '../../../src/lib/domain';
import type { Address } from '@agenticprimitives/types';
import type { ConnectionKind } from '@agenticprimitives/agent-naming';
import { cardSty, btnSty, btnPrimarySty, mono, mutedText, errorText, inputSty, badgeStyle, modalOverlaySty, shortAddr } from '../../../src/components/portal/theme';

const BADGE = badgeStyle('ok');
const NEUTRAL = badgeStyle('neutral');

const KINDS: ConnectionKind[] = ['wallet', 'google', 'youversion', 'passkey', 'email', 'phone', 'multi'];
const viaToKind = (via: string | undefined): ConnectionKind => {
  const v = (via ?? '').toLowerCase();
  if (v === 'wallet') return 'wallet';
  if (v === 'youversion') return 'youversion';
  if (v === 'google') return 'google';
  if (v === 'email') return 'email';
  if (v === 'phone') return 'phone';
  if (v === 'passkey') return 'passkey';
  return 'passkey';
};

interface NameRow extends AgentRegistryRow {
  connectionKind: ConnectionKind | null;
  connectionAddress: string | null;
}

export default function NamingPage() {
  // `useSearchParams` needs a Suspense boundary for the static shell; the page itself is unchanged below it.
  return <Suspense fallback={null}><NamingPageInner /></Suspense>;
}

function NamingPageInner() {
  const { session, profile, agentName, agentAddress, agentDeployed, refreshProfile } = useSession();
  // ap-town spec 430 N2 — sent here by the town's naming service with a label to claim and a way back.
  const handoff = useTownHandoff();
  const ret = useTownReturn();
  const editing = useSearchParams()?.get('name') ?? null;
  const [handoffClaimed, setHandoffClaimed] = useState<string | null>(null);
  // Resolve the SIGNING credential from the profile's credential kind (not the cookie's defaulted via):
  // a Google/YouVersion session's credential is `oidc` → KMS signing, NOT a (nonexistent) passkey.
  // Without this, a social member's name claim mis-routes to a passkey prompt that times out.
  const memberVia = resolveVia(profile?.credential as string | undefined, session?.via);
  const [rows, setRows] = useState<NameRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editFor, setEditFor] = useState<NameRow | null>(null);
  // The connected home is deployed but NAMELESS (spec 257 name-deferral, e.g. Google onboarding) → offer
  // the nameless→named transition right here. Publishing a connection is a SEPARATE opt-in choice.
  const isNameless = !!agentAddress && agentDeployed && !agentName;
  /** THIS agent's row out of the naming service — the page is about one name now, not a roster. */
  const own = rows?.find((r) => r.subjectAgent.toLowerCase() === (agentAddress ?? '').toLowerCase()) ?? null;

  const load = useCallback(async () => {
    setRows(null); setErr(null);
    try {
      const base = await loadRegistry();
      const marked = await markCustody(base, session?.via, agentName, session?.token);
      // Names you steward (custody confirmed) — the ones you can manage here.
      const mine = marked.filter((r) => r.mine === true && r.name);
      // Fetch each name's published connection record (name-info now returns it).
      const withConn = await Promise.all(mine.map(async (r) => {
        const info = await fetch(`/connect/name-info?name=${encodeURIComponent(r.name!)}`).then((x) => x.json()).catch(() => ({}));
        return { ...r, connectionKind: (info?.connectionKind ?? null) as ConnectionKind | null, connectionAddress: info?.connectionAddress ?? null };
      }));
      setRows(withConn.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')));
    } catch (e) { setErr(String(e)); }
  }, [session?.via, agentName, session?.token]);
  useEffect(() => { void load(); }, [load]);

  return (
    <SectionShell
      title="Naming"
      description="Your public name, and what it says about you to anyone who looks it up."
    >
      {handoff && <TownHandoffNote handoff={handoff} claimed={handoffClaimed} kind="person" />}
      {!handoff && editing && <TownDoneNote ret={ret} name={editing} />}

      {/* Nameless → named (spec 257/280): claim a name, and everything below becomes available. */}
      {/* ap-town spec 431 — a purchased ending: the person buys their first name from their treasury. */}
      {isNameless && agentAddress && isPricedTld(NEW_PERSON_TLD) && (
        <PurchaseNameCard
          owner={agentAddress}
          kind="person"
          via={memberVia}
          token={session?.token ?? null}
          tld={NEW_PERSON_TLD}
          initialLabel={handoff?.label}
          initialAbout={handoff?.about}
          onDone={(n) => { setHandoffClaimed(n); if (handoff) finishTownHandoff(handoff, { name: n, agent: agentAddress }); void (async () => { for (let i = 0; i < 10; i++) { const p = session?.token ? await fetchProfile(session.token).catch(() => null) : null; if (p?.name) break; await new Promise((r) => setTimeout(r, 1500)); } await refreshProfile(); await load(); notifyAgentsChanged(); })(); }}
        />
      )}
      {isNameless && agentAddress && !isPricedTld(NEW_PERSON_TLD) && (
        <ClaimNameCard
          agent={agentAddress}
          via={memberVia}
          token={session?.token ?? null}
          initialLabel={handoff?.label}
          onNamed={(n) => {
            setHandoffClaimed(n);
            if (handoff) finishTownHandoff(handoff, { name: n, agent: agentAddress });
            // The claim is MINED, but the server's reverse-resolve can lag the RPC read replica — a
            // single immediate refresh raced it and lost. Poll until the name resolves (bounded), then
            // commit the profile + nudge every agents dropdown (topbar switcher included).
            void (async () => {
              for (let i = 0; i < 10; i++) {
                const p = session?.token ? await fetchProfile(session.token).catch(() => null) : null;
                if (p?.name) break;
                await new Promise((r) => setTimeout(r, 1500));
              }
              await refreshProfile();
              await load();
              notifyAgentsChanged();
            })();
          }}
        />
      )}

      {/* This page is about THIS agent's name. The roster of every named agent you steward used to live
          here; each of those agents has its own Naming page now, reached from Stewardship — a list of
          other agents on your own naming page was a second way to manage things this page does not own.
          The tier essay and the "All metadata →" link went with it: the tiers are the sections below, in
          the order you meet them, and the page they linked to no longer exists. */}
      {!isNameless && agentName && (
        <div style={{ ...cardSty, marginBottom: '1.1rem', borderColor: 'var(--color-sage-500, #059669)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '.6rem', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '.7rem', letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--color-text-faint)' }}>✓ Your public name</div>
              <strong style={{ fontSize: '1.05rem' }}>{agentName}</strong>
              <div style={{ ...mono, fontSize: '.76rem', ...mutedText, marginTop: '.15rem' }}>
                {nameLabel(agentName)}.{CONNECT_DOMAIN}{agentAddress ? ` · ${shortAddr(agentAddress)}` : ''}
              </div>
            </div>
            {own && (
              <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={own.connectionKind ? BADGE : NEUTRAL}>
                  {own.connectionKind ? `● sign-in by name: ${own.connectionKind}` : 'sign-in by name not published'}
                </span>
                <button style={btnSty} onClick={() => setEditFor(own)}>{own.connectionKind ? 'Change' : 'Publish'}</button>
              </div>
            )}
          </div>
          <p style={{ fontSize: '.74rem', color: 'var(--color-text-faint)', margin: '.55rem 0 0' }}>
            Everything on this page is <strong>public</strong> — it is what your name tells the world. Your
            personal details stay private in your vault (Profile) and are shared only through a delegation
            you grant.
          </p>
        </div>
      )}

      {err && <div style={cardSty}><b style={errorText}>Error</b> <span style={mutedText}>{err}</span></div>}

      {/* Change or clear the name. Shown whether or not one is presented right now: an agent with a
          cleared name still HOLDS its labels, and presenting one again is the way back. */}
      {agentAddress && agentDeployed && (
        <ChangeNameCard
          agent={agentAddress}
          kind="person"
          via={memberVia}
          token={session?.token ?? null}
          initialLabel={handoff?.label}
          onChanged={(n) => { if (n) { setHandoffClaimed(n); if (handoff) finishTownHandoff(handoff, { name: n, agent: agentAddress }); else if (ret.popup) finishTownHandoff(ret, { name: n, agent: agentAddress, changed: true }); } void (async () => { await refreshProfile(); await load(); notifyAgentsChanged(); })(); }}
        />
      )}

      {/* The records published under this name (including the A2A endpoint), the card projection that
          writes them, and the read-only account profile. */}
      {!isNameless && <AgentNamingEditor kind="person" agent="" />}

      {editFor && (
        <PublishPanel
          row={editFor}
          via={memberVia}
          name={agentName}
          token={session?.token ?? null}
          onClose={() => setEditFor(null)}
          onDone={() => { setEditFor(null); void load(); }}
        />
      )}
    </SectionShell>
  );
}

/** Publish ceremony: the name's own SA writes its connection record (owner-gated), signed by the steward's
 *  credential, gasless. The address is written ONLY when the explicit "publish address (public)" box is on. */
function PublishPanel({ row, via: viaStr, name, token, onClose, onDone }: {
  row: NameRow; via: string; name: string | null; token: string | null; onClose: () => void; onDone: () => void;
}) {
  const vl = viaStr.toLowerCase();
  const via: Via = vl === 'wallet' ? 'wallet' : vl === 'google' ? 'google' : vl === 'youversion' ? 'youversion' : vl === 'email' ? 'email' : vl === 'phone' ? 'phone' : 'passkey';
  const [kind, setKind] = useState<ConnectionKind>(row.connectionKind ?? viaToKind(viaStr));
  const [publishAddr, setPublishAddr] = useState<boolean>(!!row.connectionAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const addressKind = kind === 'wallet' || kind === 'google' || kind === 'youversion'; // passkey/multi have no pre-select address

  const run = async () => {
    setBusy(true); setError(null);
    try {
      let address: `0x${string}` | undefined;
      if (publishAddr && addressKind) {
        const cred = await resolveCredential(via, name, token);
        if (cred?.kind === 'eoa') address = cred.address;
        else if (publishAddr) { setError('Could not resolve your connection address for this credential.'); setBusy(false); return; }
      }
      const signHash = await signHashFor(via, row.subjectAgent, token ? { token } : undefined);
      const res = await setConnectionInfo(row.subjectAgent, row.name!, kind, signHash, address ? { address } : {});
      if (res.ok) setDone(true);
      else setError(res.error);
    } catch (e) { setError(String((e as Error)?.message ?? e)); }
    finally { setBusy(false); }
  };

  return (
    <div role="dialog" aria-modal="true" style={modalOverlaySty} onClick={busy ? undefined : onClose}>
      <div style={{ ...cardSty, maxWidth: 540, width: '100%', padding: '1.5rem', boxShadow: 'var(--shadow-modal)' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0, marginBottom: '.6rem' }}>Publish connection for {row.name}</h3>
        {done ? (
          <>
            <p style={{ fontSize: '.9rem', color: 'var(--color-sage-700)' }}><strong>Published ✓</strong> — {row.name} now advertises how to connect.</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}><button style={btnPrimarySty} onClick={onDone}>Done</button></div>
          </>
        ) : (
          <>
            <p style={{ fontSize: '.86rem', color: 'var(--color-text-body)', marginTop: 0 }}>
              Choose the credential a returning person uses to connect to <strong>{row.name}</strong>. This is published
              publicly on the naming service.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem', margin: '.8rem 0' }}>
              {KINDS.map((k) => (
                <button key={k} onClick={() => setKind(k)} style={{ ...(k === kind ? btnPrimarySty : btnSty), padding: '.4rem .7rem' }}>{k}</button>
              ))}
            </div>
            {addressKind && (
              <label style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-start', fontSize: '.82rem', color: 'var(--color-text-body)', margin: '.6rem 0' }}>
                <input type="checkbox" checked={publishAddr} onChange={(e) => setPublishAddr(e.target.checked)} style={{ marginTop: '.2rem' }} />
                <span>Also publish my connection <strong>address</strong> to pre-select my account — <strong style={{ color: 'var(--color-amber-700)' }}>this is public</strong> (the address is already on-chain; this makes it discoverable by name).</span>
              </label>
            )}
            <p style={{ fontSize: '.8rem', ...mutedText }}>
              Your agent writes its own naming record — <code style={mono}>msg.sender == owner</code> — signed by your {via} credential, sponsored. One prompt.
            </p>
            {error && <p style={{ fontSize: '.82rem', ...errorText, marginTop: '.6rem' }}>{error}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '.6rem', marginTop: '1rem' }}>
              <button style={btnSty} onClick={onClose} disabled={busy}>Cancel</button>
              <button style={btnPrimarySty} onClick={run} disabled={busy}>{busy ? 'Publishing…' : 'Sign & publish'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Nameless → named (spec 257). Claim a public name for the deployed-but-unnamed home, signed by the
 *  member's current credential, gasless. Publishing a connection record is a SEPARATE opt-in step. Reuses
 *  the existing `claimName` primitive (which also fires the discovery re-index). */
function ClaimNameCard({ agent, via, token, onNamed, initialLabel }: { agent: Address; via: Via; token: string | null; onNamed: (name: string) => void; initialLabel?: string | undefined }) {
  const [value, setValue] = useState(initialLabel ?? '');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<string | null>(null);
  const label = nameLabel(value);

  const claim = async () => {
    if (!label) return;
    setBusy(true); setErr(null);
    try {
      const signHash = await signHashFor(via, agent, token ? { token } : undefined);
      const res = await claimName(agent, signHash, label, (s) => setStep(s));
      if (res.ok) { setClaimed(res.name); onNamed(res.name); }
      else setErr(res.error);
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    finally { setBusy(false); }
  };

  // Explicit success state: the claim is mined — say so IMMEDIATELY and loudly, even while the
  // profile/header catch up to the chain read (the silent lag read as "nothing happened").
  if (claimed) {
    return (
      <div style={{ ...cardSty, marginBottom: '1.1rem', borderColor: 'var(--color-sage-500, #059669)' }}>
        <h3 style={{ marginTop: 0, marginBottom: '.4rem' }}>✓ Name claimed</h3>
        <p style={{ fontSize: '.9rem', margin: 0 }}>
          You are now <strong style={mono as React.CSSProperties}>{claimed}</strong> — your home lives at{' '}
          <strong style={mono as React.CSSProperties}>{nameLabel(claimed)}.{CONNECT_DOMAIN}</strong>.
        </p>
        <p style={{ fontSize: '.78rem', color: 'var(--color-text-faint)', marginTop: '.5rem' }}>
          Updating the header and workspace menus… (a few seconds while the network read catches up)
        </p>
      </div>
    );
  }

  return (
    <div style={{ ...cardSty, marginBottom: '1.1rem', borderColor: 'var(--color-amber-400)' }}>
      <h3 style={{ marginTop: 0, marginBottom: '.4rem' }}>Give your home a public name</h3>
      <p style={{ fontSize: '.85rem', color: 'var(--color-text-body)', marginTop: 0 }}>
        Your agent is deployed but <strong>unnamed</strong>. Claim a name so others can find it — and so you can
        re-connect by name on a new device. Your Smart Agent address doesn’t change; the name is a facet pointing at it.
      </p>
      {busy ? (
        <p style={mutedText}>{step || 'Claiming your name…'}</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder="e.g. rich-pedersen" autoCapitalize="none" spellCheck={false} aria-label="Your public name"
              style={{ ...inputSty, flex: 1, minWidth: 180 }}
            />
            <button style={btnPrimarySty} onClick={claim} disabled={!label}>Claim name</button>
          </div>
          {/* Both facts, labelled. This showed only `<label>.<connect domain>` — the URL your home lives
              at — beside a button that claims a NAME. The two differ (`phone-6112.me` vs
              `phone-6112.faithnet.me`), so the preview was answering a question the card had not asked
              and hiding the one it had. The root is the deployment's person root, which is what the claim
              will actually use. */}
          {label && (
            <p style={{ fontSize: '.78rem', ...mutedText, marginTop: '.4rem', display: 'grid', gap: '.1rem' }}>
              <span>Name: <b style={mono as React.CSSProperties}>{label}.{NEW_PERSON_TLD}</b></span>
              <span>Home: <b style={mono as React.CSSProperties}>{label}.{CONNECT_DOMAIN}</b></span>
            </p>
          )}
          {err && <p style={{ fontSize: '.82rem', ...errorText, marginTop: '.4rem' }}>{err}</p>}
          <p style={{ fontSize: '.78rem', color: 'var(--color-text-faint)', marginTop: '.5rem' }}>After naming, you can publish an opt-in connection record so you can sign back in by name.</p>
        </>
      )}
    </div>
  );
}
