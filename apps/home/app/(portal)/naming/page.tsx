'use client';
// Agent Naming Service (spec 280). Manage the names you steward and publish the OPT-IN, owner-authorized,
// PUBLIC connection-bootstrap record (kind + optional pre-select address) so a returning person on a fresh
// device can discover how to connect to your Smart Agent by name. Publishing is always an explicit action
// here (never automatic); the address toggle is clearly labeled "public" because the bootstrap read is a
// public directory lookup by necessity (ADR-0040 amendment). Owner-signed, gasless — one custody prompt.
// Styling uses the shared inline theme (src/components/portal/theme.ts) — same amber tokens as the
// rest of the portal.
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { loadRegistry, markCustody, type AgentRegistryRow } from '../../../src/lib/registry';
import { setConnectionInfo, resolveCredential, claimName, fetchProfile } from '../../../src/connect-client';
import { notifyAgentsChanged } from '../../../src/components/portal/ManagedAgents';
import { readNameRecords, writeNameProperties, EDITABLE_PROPS, type EditablePropKey } from '../../../src/lib/name-properties';
import { signHashFor, resolveVia, type Via } from '../../../src/home/onboarding';
import { nameLabel, CONNECT_DOMAIN } from '../../../src/lib/domain';
import type { Address } from '@agenticprimitives/types';
import type { ConnectionKind } from '@agenticprimitives/agent-naming';
import { cardSty, btnSty, btnPrimarySty, mono, mutedText, errorText, inputSty, infoBannerSty, badgeStyle, modalOverlaySty, shortAddr } from '../../../src/components/portal/theme';

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
  const { session, profile, agentName, agentAddress, agentDeployed, refreshProfile } = useSession();
  // Resolve the SIGNING credential from the profile's credential kind (not the cookie's defaulted via):
  // a Google/YouVersion session's credential is `oidc` → KMS signing, NOT a (nonexistent) passkey.
  // Without this, a social member's name claim mis-routes to a passkey prompt that times out.
  const memberVia = resolveVia(profile?.credential as string | undefined, session?.via);
  const [rows, setRows] = useState<NameRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editFor, setEditFor] = useState<NameRow | null>(null);
  const [propsFor, setPropsFor] = useState<NameRow | null>(null);
  // The connected home is deployed but NAMELESS (spec 257 name-deferral, e.g. Google onboarding) → offer
  // the nameless→named transition right here. Publishing a connection is a SEPARATE opt-in choice.
  const isNameless = !!agentAddress && agentDeployed && !agentName;

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
      title="Naming Service"
      description="Manage the names you steward. Publish an opt-in connection record so you can re-connect to your agent by name on a new device — you choose what's shared."
    >
      {/* Nameless → named transition (spec 257/280). Deployed-but-unnamed home: claim a name, then
          optionally publish a connection — all from here. */}
      {isNameless && agentAddress && (
        <ClaimNameCard
          agent={agentAddress}
          via={memberVia}
          token={session?.token ?? null}
          onNamed={() => {
            // Spec 280: publishing a connection record (the public name→credential reverse mapping) is
            // an OPT-IN, owner-authorized, NEVER-automatic action. Claiming a name does NOT prompt it —
            // the freshly-named agent simply appears below with an OPTIONAL "Publish connection" button
            // the member can use later by choice.
            //
            // The claim is MINED, but the server's reverse-resolve can lag the RPC read replica — a
            // single immediate refresh raced it and lost (header stayed "Your portal" until a manual
            // reload). Poll until the name resolves (bounded), then commit the profile + nudge every
            // agents dropdown (topbar switcher included).
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

      {/* Named state — say it loudly (the silent list read as "did the claim work?"). One card, with
          direct paths to BOTH public-metadata surfaces: name properties (node-keyed records on the
          naming service, spec 314) and the agent profile (SA-keyed, /profile). */}
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
            <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              {(() => {
                const own = rows?.find((r) => r.subjectAgent.toLowerCase() === (agentAddress ?? '').toLowerCase());
                return own ? <button style={btnSty} onClick={() => setPropsFor(own)}>Name properties</button> : null;
              })()}
              <a href="/profile" style={{ fontSize: '.82rem' }}>Private profile (vault) →</a>
            </div>
          </div>
          {/* Metadata tiers (docs/architecture/agent-metadata-tiers.md): say plainly what lives where. */}
          <p style={{ fontSize: '.74rem', color: 'var(--color-text-faint)', margin: '.55rem 0 0' }}>
            <strong>Name properties</strong> are public under this name — anyone can read them. Your personal
            details stay <strong>private in your vault</strong> and are shared only via delegations you grant.
            (A third tier — raw on-chain ERC-4337 account metadata — is public and system-managed; the home
            rarely touches it.)
          </p>
        </div>
      )}

      <div style={{ ...infoBannerSty, marginBottom: '1.1rem', fontSize: '.82rem' }}>
        <strong>Connection records are public.</strong> They live on the public naming service so a returning person can
        discover how to connect — there is no private way to do this (you have no credential yet at that point). Publishing
        the <strong>kind</strong> (wallet / passkey / Google / YouVersion) is enough to connect; publishing your
        <strong> address</strong> is an optional convenience that pre-selects your wallet account and is visible to anyone.
      </div>

      {err ? <div style={cardSty}><b style={errorText}>Error</b> <span style={mutedText}>{err}</span></div>
        : !rows ? <p style={mutedText}>Loading the names you steward…</p>
        : rows.length === 0 ? <p style={mutedText}>No named agents under your stewardship yet.</p>
        : (
          <div style={{ display: 'grid', gap: '.7rem' }}>
            {rows.map((r) => (
              <div key={r.subjectAgent} style={cardSty}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '.5rem', alignItems: 'center' }}>
                  <div>
                    <strong>{r.name}</strong>
                    <div style={{ ...mono, fontSize: '.74rem', ...mutedText, marginTop: '.2rem' }}>{shortAddr(r.subjectAgent)}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
                    {r.connectionKind
                      ? <span style={BADGE}>● connect: {r.connectionKind}{r.connectionAddress ? ` · ${shortAddr(r.connectionAddress)}` : ''}</span>
                      : <span style={NEUTRAL}>no connection published</span>}
                    <button style={btnSty} onClick={() => setPropsFor(r)}>Properties</button>
                    <button style={btnPrimarySty} onClick={() => setEditFor(r)}>{r.connectionKind ? 'Update' : 'Publish connection'}</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

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

      {propsFor && (
        <PropertiesPanel
          row={propsFor}
          via={memberVia}
          token={session?.token ?? null}
          onClose={() => setPropsFor(null)}
        />
      )}
    </SectionShell>
  );
}

/** SHACL property manager (spec 314 W3). Edits the ontology-registered naming records — the same
 *  attribute store the discovery indexer projects into the knowledge base. Validation happens twice:
 *  the TS mirror (`encodeRecords`) before any prompt, and the on-chain `OntologyTermRegistry` at write.
 *  One batched, sponsored userOp by the name's own SA; the KB re-indexes within seconds. */
function PropertiesPanel({ row, via: viaStr, token, onClose }: {
  row: NameRow; via: string; token: string | null; onClose: () => void;
}) {
  const vl = viaStr.toLowerCase();
  const via: Via = vl === 'wallet' ? 'wallet' : vl === 'google' ? 'google' : vl === 'youversion' ? 'youversion' : vl === 'email' ? 'email' : vl === 'phone' ? 'phone' : 'passkey';
  const [current, setCurrent] = useState<Partial<Record<EditablePropKey, string>> | null>(null);
  const [draft, setDraft] = useState<Partial<Record<EditablePropKey, string>>>({});
  const [system, setSystem] = useState<{ addr?: string; agentKind?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readNameRecords(row.name!)
      .then((r) => {
        if (cancelled) return;
        const cur: Partial<Record<EditablePropKey, string>> = {};
        for (const { key } of EDITABLE_PROPS) { const v = r[key]; if (typeof v === 'string') cur[key] = v; }
        setCurrent(cur);
        setDraft(cur);
        setSystem({ addr: r.addr, agentKind: r.agentKind });
      })
      .catch((e) => { if (!cancelled) setError(String((e as Error)?.message ?? e)); });
    return () => { cancelled = true; };
  }, [row.name]);

  const changes: Partial<Record<EditablePropKey, string>> = {};
  if (current) {
    for (const { key } of EDITABLE_PROPS) {
      const d = (draft[key] ?? '').trim();
      const c = (current[key] ?? '').trim();
      if (d !== c) changes[key] = d;
    }
  }
  const dirty = Object.keys(changes).length > 0;

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const signHash = await signHashFor(via, row.subjectAgent, token ? { token } : undefined);
      const res = await writeNameProperties(row.subjectAgent, row.name!, changes, signHash);
      if (res.ok) setDone(true);
      else setError(res.error);
    } catch (e) { setError(String((e as Error)?.message ?? e)); }
    finally { setBusy(false); }
  };

  return (
    <div role="dialog" aria-modal="true" style={modalOverlaySty} onClick={busy ? undefined : onClose}>
      <div style={{ ...cardSty, maxWidth: 600, width: '100%', padding: '1.5rem', boxShadow: 'var(--shadow-modal)', maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0, marginBottom: '.4rem' }}>Properties of {row.name}</h3>
        <p style={{ fontSize: '.82rem', color: 'var(--color-text-body)', marginTop: 0 }}>
          <strong>Public under this name — anyone can read these.</strong> They are the SHACL-registered
          records on the naming service (validated against the on-chain ontology, indexed into the knowledge
          base within seconds): what you choose to publish about yourself in the context of {row.name}. Your
          personal details are a different tier — they stay private in your vault.
        </p>
        {done ? (
          <>
            <p style={{ fontSize: '.9rem', color: 'var(--color-sage-700)' }}><strong>Saved ✓</strong> — the knowledge base is re-indexing {row.name}.</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}><button style={btnPrimarySty} onClick={onClose}>Done</button></div>
          </>
        ) : !current && !error ? (
          <p style={mutedText}>Reading current records…</p>
        ) : (
          <>
            {current && (
              <div style={{ display: 'grid', gap: '.7rem', margin: '.8rem 0' }}>
                {EDITABLE_PROPS.map(({ key, label, hint }) => (
                  <label key={key} style={{ display: 'grid', gap: '.2rem', fontSize: '.82rem', color: 'var(--color-text-body)' }}>
                    <span style={{ fontWeight: 700 }}>{label}</span>
                    <input
                      value={draft[key] ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                      placeholder={hint}
                      style={inputSty}
                    />
                  </label>
                ))}
                <div style={{ fontSize: '.76rem', ...mutedText }}>
                  System records (managed by their own ceremonies):{' '}
                  <span style={mono}>addr {system.addr ? shortAddr(system.addr) : '—'}</span>
                  {' · '}<span style={mono}>agentKind {system.agentKind ?? '—'}</span>
                </div>
              </div>
            )}
            {error && <p style={{ fontSize: '.82rem', ...errorText }}>{error}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '.6rem', marginTop: '1rem' }}>
              <button style={btnSty} onClick={onClose} disabled={busy}>Cancel</button>
              <button style={btnPrimarySty} onClick={save} disabled={busy || !dirty || !current}>
                {busy ? 'Signing…' : `Sign & save${dirty ? ` (${Object.keys(changes).length})` : ''}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
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
function ClaimNameCard({ agent, via, token, onNamed }: { agent: Address; via: Via; token: string | null; onNamed: (name: string) => void }) {
  const [value, setValue] = useState('');
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
          {label && <p style={{ ...mono, fontSize: '.78rem', ...mutedText, marginTop: '.4rem' }}>→ {label}.{CONNECT_DOMAIN}</p>}
          {err && <p style={{ fontSize: '.82rem', ...errorText, marginTop: '.4rem' }}>{err}</p>}
          <p style={{ fontSize: '.78rem', color: 'var(--color-text-faint)', marginTop: '.5rem' }}>After naming, you can publish an opt-in connection record so you can sign back in by name.</p>
        </>
      )}
    </div>
  );
}
