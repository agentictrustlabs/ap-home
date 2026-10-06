'use client';
// REGISTER A NEW AGENT UNDER A NAME — the charter-and-buy ceremony (ap-town spec 431 §5.1, W5b). The town's naming
// service sends a connected person here with `?charter=<kind>&claim=<label>&tld=<tld>&return=…`: create the agent
// they will custody — a second person (a persona), an organization, a team, a service, a church, a circle, a
// household — buy its name from the person's treasury, present it, and send them back. The Home's part is the
// signatures and nothing else; the kind is decided by the ending (the suffix is the type, never a free choice).
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSession } from '../../../../src/context/session';
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { createAgentWithBirthrights, notifyAgentsChanged } from '../../../../src/components/portal/ManagedAgents';
import { BusyButton } from '../../../../src/components/shared/BusyButton';
import { kindNameIsBought } from '../../../../src/home/charter-name';
import { resolveVia } from '../../../../src/home/onboarding';
import { coins, treasuryBalance } from '../../../../src/home/treasury-birthright';
import { creatableKinds, type CreatableKind } from '../../../../src/lib/agent-class';
import { nameLabel, townReturnUrl, TOWN_NAMING_ORIGIN } from '../../../../src/lib/domain';
import { NAMING_COIN, TREASURY_BIRTHRIGHT_COINS, namePrice } from '../../../../src/lib/naming-price';
import { listManagedAgents, requestClaimTicket, resolveCredential, typedTldForKind, type AgentKind, type PurchaseRefusal } from '../../../../src/connect-client';
import { btnPrimarySty, btnSty, cardSty, errorText, inputSty, mono, mutedText } from '../../../../src/components/portal/theme';

export default function RegisterPage() {
  return <Suspense fallback={null}><RegisterInner /></Suspense>;
}

/** The kinds the hand-off may name (`charter=`), as the person's own charter picker knows them. */
const CHARTER_KINDS: AgentKind[] = ['person', 'org', 'team', 'service', 'church', 'circle', 'household', 'workspace'];

function RegisterInner() {
  const { session, profile, agentAddress, agentName } = useSession();
  const params = useSearchParams();
  const wantKind = (params?.get('charter') ?? '') as AgentKind;
  const wantTld = params?.get('tld') ?? '';
  const returnUrl = townReturnUrl(params?.get('return'));
  const via = resolveVia(profile?.credential as string | undefined, session?.via);
  const token = session?.token ?? null;

  // The kinds this chain can charter under a priced root, and the one the URL asked for.
  const choices = useMemo(() => creatableKinds('person', (k) => CHARTER_KINDS.includes(k) && kindNameIsBought(k)), []);
  const fromTld = choices.find((c) => typedTldForKind(c.kind)?.tld === wantTld);
  const [kind, setKind] = useState<AgentKind | null>(choices.find((c) => c.kind === wantKind)?.kind ?? fromTld?.kind ?? null);
  const choice: CreatableKind | undefined = choices.find((c) => c.kind === kind);
  const tld = kind ? typedTldForKind(kind)?.tld ?? '' : '';

  const [value, setValue] = useState(params?.get('claim')?.split('.')[0] ?? '');
  const label = nameLabel(value);
  const price = label.length >= 3 && tld ? namePrice(label, tld) : null;
  const [commonName, setCommonName] = useState('');
  const [email, setEmail] = useState('');
  const [treasury, setTreasury] = useState<{ address: `0x${string}`; balance: bigint } | null | undefined>(undefined);
  const [avail, setAvail] = useState<'checking' | 'available' | 'taken' | null>(null);
  const [preview, setPreview] = useState<{ domain: string | null } | PurchaseRefusal | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState('');
  const [made, setMade] = useState<{ agent: string; name: string } | null>(null);

  // The payer: the person's treasury (born with 1,000 SHQ; made on the way if missing).
  useEffect(() => {
    if (!token) return;
    let live = true;
    void (async () => {
      const all = await listManagedAgents(token, 'any').catch(() => []);
      const t = all.find((a) => a.kind === 'person-treasury' && (a.relationship ?? 'steward') === 'steward')?.agent;
      if (!live) return;
      if (!t) { setTreasury(null); return; }
      setTreasury({ address: t, balance: await treasuryBalance(t).catch(() => 0n) });
    })();
    return () => { live = false; };
  }, [token]);

  // Availability + the gate's preview (the domain rule), debounced. The new agent does not exist yet, so the
  // preview asks for the PERSON as owner — the domain rule is proven by the custodying person's email either way.
  useEffect(() => {
    if (!label || label.length < 3 || !tld || !token || !agentAddress) { setAvail(null); setPreview(null); return; }
    let live = true;
    setAvail('checking');
    const t = setTimeout(async () => {
      const info = await fetch(`/connect/name-info?name=${encodeURIComponent(`${label}.${tld}`)}`).then((r) => r.json()).catch(() => ({})) as { exists?: boolean };
      if (!live) return;
      setAvail(info.exists ? 'taken' : 'available');
      if (!info.exists && treasury) {
        const custodian = await resolveCredential(via, null, token).catch(() => null);
        const p = await requestClaimTicket(token, { label, tld, owner: agentAddress, payer: treasury.address, ...(email ? { email } : {}), ...(custodian ? { custodian } : {}), preview: true });
        if (live) setPreview(p.ok ? { domain: p.domain } : p);
      }
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [label, tld, token, agentAddress, treasury, email, via]);

  const refusal: PurchaseRefusal | null = preview && 'ok' in preview ? preview : null;
  const protectedBy = refusal ? refusal.domain ?? null : preview ? preview.domain : null;
  const short = price !== null && treasury ? coins(treasury.balance) < price : false;
  const canGo = !!kind && !!token && !!agentAddress && avail === 'available' && price !== null && !short && !refusal && !busy;

  const go = async () => {
    if (!kind || !token || !agentAddress) return;
    setBusy(true); setErr(''); setStep('');
    const res = await createAgentWithBirthrights({ kind, label, parent: agentAddress, person: agentAddress, via, ...(kind === 'org' ? { displayName: commonName } : {}), ...(email ? { email } : {}) }, token, setStep);
    setBusy(false); setStep('');
    if (!res.ok) { setErr(res.error); return; }
    setMade({ agent: res.result.agent, name: res.result.name });
    notifyAgentsChanged();
  };

  const host = new URL(TOWN_NAMING_ORIGIN).host;
  const back = (name: string) => {
    if (!returnUrl) return null;
    try { const u = new URL(returnUrl); if (u.pathname.startsWith('/name/')) u.pathname = `/name/${encodeURIComponent(name)}`; return u.toString(); } catch { return returnUrl; }
  };

  return (
    <SectionShell title="Register a new agent" description="An agent you keep, named at creation. Your Home signs; the town's naming service only reads.">
      {made ? (
        <div style={{ ...cardSty, borderColor: 'var(--color-sage-500, #059669)' }}>
          <h3 style={{ marginTop: 0, marginBottom: '.4rem' }}>✓ {made.name} is yours</h3>
          <p style={{ margin: '0 0 .6rem', fontSize: '.9rem' }}>
            A new {choice?.label.toLowerCase() ?? kind} at <span style={mono as React.CSSProperties}>{made.agent}</span>, custodied by you, with its own treasury, presenting <strong>{made.name}</strong>. It is under <a href="/stewardship">Stewardship</a> like any agent of yours.
          </p>
          <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
            {back(made.name) && <a style={{ ...btnPrimarySty, textDecoration: 'none' }} href={back(made.name)!}>See {made.name} on {host} →</a>}
            <a style={{ ...btnSty, textDecoration: 'none' }} href="/stewardship">Stewardship</a>
          </div>
        </div>
      ) : (
        <div style={cardSty}>
          {returnUrl && (
            <p style={{ ...mutedText, fontSize: '.8rem', margin: '0 0 .6rem' }}>
              From <span style={mono as React.CSSProperties}>{host}</span>{agentName ? <> · you are <strong>{agentName}</strong></> : null}. <a href={returnUrl} style={{ color: 'inherit' }}>Back without registering</a>
            </p>
          )}
          {!token || !agentAddress ? <p style={mutedText}>Sign in first.</p> : (
            <>
              <label style={{ display: 'flex', gap: '.5rem', alignItems: 'center', fontSize: '.85rem', marginBottom: '.6rem' }}>
                <span style={mutedText}>What it is</span>
                <select value={kind ?? ''} disabled={busy} onChange={(e) => { setKind(e.target.value as AgentKind); setErr(''); }} style={{ ...inputSty, flex: 1 }}>
                  {!kind && <option value="">Choose…</option>}
                  {choices.map((c) => <option key={c.kind} value={c.kind}>{c.label} · .{typedTldForKind(c.kind)?.tld}</option>)}
                </select>
              </label>
              {choice && <p style={{ ...mutedText, fontSize: '.8rem', margin: '0 0 .7rem' }}>{choice.blurb}</p>}

              <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <input value={value} onChange={(e) => { setValue(e.target.value); setErr(''); }} placeholder="its name" autoCapitalize="none" spellCheck={false} aria-label="Name" disabled={busy || !kind} style={{ ...inputSty, flex: 1, minWidth: 180 }} />
                <span style={{ ...mutedText, fontSize: '.85rem' }}>{tld ? `.${tld}` : ''}</span>
                <span style={{ fontSize: '.95rem', fontWeight: 650, minWidth: 64 }}>{price === null ? '' : `${price} ${NAMING_COIN?.symbol ?? 'SHQ'}`}</span>
              </div>
              {label.length >= 3 && tld && (
                <p style={{ fontSize: '.8rem', margin: '.45rem 0 0', ...mutedText }}>
                  {avail === 'checking' ? 'Checking…' : avail === 'taken' ? `${label}.${tld} is already registered.` : avail === 'available' ? `${label}.${tld} is free${price !== null ? ` · ${price} SHQ` : ''}${short ? ' · your treasury is short' : ''}.` : ''}
                </p>
              )}
              {kind === 'org' && (
                <input value={commonName} onChange={(e) => setCommonName(e.target.value)} placeholder="name people know it by (optional)" disabled={busy} aria-label="Common name" style={{ ...inputSty, marginTop: '.5rem', width: '100%' }} />
              )}

              <p style={{ fontSize: '.82rem', ...mutedText, margin: '.7rem 0 0' }}>
                {treasury === undefined ? 'Finding your treasury…' : treasury === null ? `You have no treasury yet; one is made on the way, with ${TREASURY_BIRTHRIGHT_COINS} SHQ.` : <>Paid from your treasury <span style={mono as React.CSSProperties}>{`${treasury.address.slice(0, 6)}…${treasury.address.slice(-4)}`}</span> · balance {coins(treasury.balance)} SHQ.</>}
                {' '}The new agent is born with its own empty treasury; you sign for both.
              </p>

              {protectedBy && (
                <div style={{ marginTop: '.7rem', padding: '.6rem .8rem', borderRadius: 10, background: 'var(--color-surface-2, #f6f1e7)', fontSize: '.84rem' }}>
                  <p style={{ margin: '0 0 .4rem' }}><strong>{label} is a domain.</strong> {refusal?.need === 'verify' ? `${email} is not a verified email on this Home.` : `To register ${label}.${tld} you need a verified email at ${protectedBy} on this Home.`}{' '}No such email? <a href="/security/sign-in" style={{ color: 'inherit' }}>Add one under Security</a>, verify the code, then come back.</p>
                  <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder={`you@${protectedBy}`} inputMode="email" aria-label={`Your email at ${protectedBy}`} style={{ ...inputSty, flex: 1, minWidth: 200 }} />
                    <button style={btnSty} onClick={() => setPreview(null)} disabled={!email}>Use this email</button>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: '.5rem', marginTop: '.9rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <BusyButton busy={busy} busyLabel={step || 'Working…'} style={btnPrimarySty} onClick={() => void go()} disabled={!canGo}>Create + buy {label && tld ? `${label}.${tld}` : 'the name'}</BusyButton>
                {returnUrl && !busy && <a href={returnUrl} style={{ ...btnSty, textDecoration: 'none' }}>Cancel</a>}
              </div>
              {err && <p style={{ ...errorText, fontSize: '.82rem', marginTop: '.5rem' }}>{err}</p>}
              <p style={{ fontSize: '.76rem', color: 'var(--color-text-faint)', marginTop: '.7rem', marginBottom: 0 }}>
                The ending is the kind: a .{tld || 'org'} name can only name {choice ? choice.label.toLowerCase() : 'that kind of agent'}. A name is an address card; it gives the new agent no authority, and you remain its custodian.
              </p>
            </>
          )}
        </div>
      )}
    </SectionShell>
  );
}
