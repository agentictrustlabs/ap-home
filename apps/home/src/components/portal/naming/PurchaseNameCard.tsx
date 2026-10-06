'use client';
// Buying a name (ap-town spec 431). The price is the package's number; the domain rule is this Home's gate; the
// fee leaves the person's treasury in the same operation that registers the name. Two signatures: the treasury
// pays and claims, the owner presents. A protected label asks for the person's verified email at that domain and
// points to Security when there is none — the rule is what sends people to add an email.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { BusyButton } from '../../shared/BusyButton';
import { btnPrimarySty, btnSty, cardSty, errorText, inputSty, mono, mutedText } from '../theme';
import { signHashFor, type Via } from '../../../home/onboarding';
import { listManagedAgents, purchaseName, requestClaimTicket, type PurchaseRefusal } from '../../../connect-client';
import { coins, ensurePersonTreasury, treasuryBalance } from '../../../home/treasury-birthright';
import { NAMING_COIN, TREASURY_BIRTHRIGHT_COINS, namePrice } from '../../../lib/naming-price';
import { nameLabel } from '../../../lib/domain';

type Phase = 'idle' | 'treasury' | 'buying' | 'done' | 'error';

export function PurchaseNameCard({ owner, kind, via, token, tld, serviceRole, initialLabel, onDone, title }: {
  owner: Address;
  kind: 'person' | 'org' | 'service' | string;
  via: Via;
  token: string | null;
  tld: string;
  serviceRole?: string | undefined;
  initialLabel?: string | undefined;
  onDone: (name: string) => void;
  title?: string;
}) {
  const [value, setValue] = useState(initialLabel ?? '');
  const label = nameLabel(value);
  const price = label.length >= 3 ? namePrice(label, tld) : null;
  const [treasury, setTreasury] = useState<Address | null | undefined>(undefined);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [avail, setAvail] = useState<'checking' | 'available' | 'taken' | null>(null);
  const [preview, setPreview] = useState<{ domain: string | null } | PurchaseRefusal | null>(null);
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [step, setStep] = useState('');
  const [err, setErr] = useState('');
  const [bought, setBought] = useState<{ name: string; price: number } | null>(null);
  const isPerson = kind === 'person';

  // The payer: a person's own treasury, or an organization's.
  const loadTreasury = useCallback(async () => {
    if (!token) return;
    const all = await listManagedAgents(token, 'any').catch(() => []);
    const t = isPerson
      ? all.find((a) => a.kind === 'person-treasury' && (a.relationship ?? 'steward') === 'steward')
      : all.find((a) => a.kind === 'org-treasury' && (a.parent ?? '').toLowerCase() === owner.toLowerCase());
    setTreasury(t?.agent ?? null);
    if (t) setBalance(await treasuryBalance(t.agent).catch(() => null));
  }, [token, owner, isPerson]);
  useEffect(() => { void loadTreasury(); }, [loadTreasury]);

  // Availability + the gate's preview (price and the domain rule), debounced.
  useEffect(() => {
    if (!label || label.length < 3 || !token) { setAvail(null); setPreview(null); return; }
    let live = true;
    setAvail('checking');
    const t = setTimeout(async () => {
      const info = await fetch(`/connect/name-info?name=${encodeURIComponent(`${label}.${tld}`)}`).then((r) => r.json()).catch(() => ({})) as { exists?: boolean };
      if (!live) return;
      setAvail(info.exists ? 'taken' : 'available');
      if (!info.exists && treasury) {
        const p = await requestClaimTicket(token, { label, tld, owner, payer: treasury, ...(email ? { email } : {}), preview: true } as never);
        if (live) setPreview(p.ok ? { domain: p.domain } : p);
      }
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [label, tld, token, owner, treasury, email]);

  const setUpTreasury = async () => {
    if (!token) return;
    setPhase('treasury'); setErr('');
    try {
      const sign = await signHashFor(via, owner, { token });
      const r = await ensurePersonTreasury({ person: owner, via, token, signPerson: sign }, setStep);
      if (!r.ok) { setErr(r.error); setPhase('error'); return; }
      setTreasury(r.treasury); setBalance(r.balance); setPhase('idle');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setPhase('error'); }
    finally { setStep(''); }
  };

  const buy = async () => {
    if (!token || !treasury || !NAMING_COIN || price === null) return;
    setPhase('buying'); setErr('');
    try {
      const signPayer = await signHashFor(via, treasury, { token });
      const signOwner = await signHashFor(via, owner, { token });
      const r = await purchaseName({ token, owner, payer: treasury, label, tld, coin: NAMING_COIN.address, ...(email ? { email } : {}), signPayer, signOwner, ...(serviceRole ? { serviceRole } : {}), onStep: setStep });
      if (!r.ok) { setPreview(r); setErr(r.error); setPhase('error'); return; }
      setBought({ name: r.name, price: r.price }); setPhase('done');
      setBalance(await treasuryBalance(treasury).catch(() => null));
      onDone(r.name);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setPhase('error'); }
    finally { setStep(''); }
  };

  const refusal: PurchaseRefusal | null = preview && 'ok' in preview ? preview : null;
  const protectedBy = refusal ? refusal.domain ?? null : preview ? preview.domain : null;
  const short = price !== null && balance !== null && NAMING_COIN ? coins(balance) < price : false;
  const canBuy = !!treasury && avail === 'available' && price !== null && !short && !refusal && phase === 'idle';

  if (bought) {
    return (
      <div style={{ ...cardSty, marginBottom: '1.1rem', borderColor: 'var(--color-sage-500, #059669)' }}>
        <h3 style={{ marginTop: 0, marginBottom: '.4rem' }}>✓ {bought.name} is yours</h3>
        <p style={{ margin: 0, fontSize: '.9rem' }}>Bought for <strong>{bought.price} SHQ</strong> from your treasury, which now holds {balance !== null ? coins(balance) : '…'} SHQ. The receipt is in the treasury's ledger. A name is an address card: it gives nobody authority.</p>
      </div>
    );
  }

  return (
    <div style={{ ...cardSty, marginBottom: '1.1rem' }}>
      <h3 style={{ marginTop: 0, marginBottom: '.3rem' }}>{title ?? `Buy your .${tld} name`}</h3>
      <p style={{ fontSize: '.85rem', color: 'var(--color-text-body)', margin: '0 0 .7rem' }}>
        A name costs Sheqel, paid from your treasury in the same signed operation that registers it. Shorter is dearer; nothing costs 50. The ending says what you are — <code>.{tld}</code> — and the chain checks it.
      </p>

      {treasury === undefined ? <p style={mutedText}>Finding your treasury…</p> : treasury === null ? (
        <div style={{ marginBottom: '.8rem' }}>
          <p style={{ fontSize: '.85rem', margin: '0 0 .5rem' }}>{isPerson ? `You have no treasury yet. Every person gets one, with ${TREASURY_BIRTHRIGHT_COINS} SHQ to start.` : 'This organization has no treasury yet. Create one under Stewardship, then come back.'}</p>
          {isPerson && <BusyButton busy={phase === 'treasury'} busyLabel={step || 'Setting up…'} style={btnPrimarySty} onClick={() => void setUpTreasury()}>Set up my treasury</BusyButton>}
        </div>
      ) : (
        <p style={{ fontSize: '.82rem', ...mutedText, margin: '0 0 .6rem' }}>
          Paid from <span style={mono as React.CSSProperties}>{treasury.slice(0, 6)}…{treasury.slice(-4)}</span> · balance {balance === null ? '…' : `${coins(balance)} SHQ`}
        </p>
      )}

      <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={value} onChange={(e) => { setValue(e.target.value); setErr(''); }} placeholder="new name" autoCapitalize="none" spellCheck={false} aria-label={`New .${tld} name`} disabled={phase === 'buying'} style={{ ...inputSty, flex: 1, minWidth: 180 }} />
        <span style={{ ...mutedText, fontSize: '.82rem' }}>.{tld}</span>
        <span style={{ fontSize: '.95rem', fontWeight: 650, minWidth: 64 }}>{price === null ? '' : `${price} SHQ`}</span>
        <BusyButton busy={phase === 'buying'} busyLabel={step || 'Buying…'} style={btnPrimarySty} onClick={() => void buy()} disabled={!canBuy}>Buy + present</BusyButton>
      </div>
      {label.length >= 3 && (
        <p style={{ fontSize: '.8rem', margin: '.45rem 0 0', ...mutedText }}>
          {avail === 'checking' ? 'Checking…' : avail === 'taken' ? `${label}.${tld} is already registered.` : avail === 'available' ? `${label}.${tld} is free${price !== null ? ` · ${price} SHQ` : ''}${short ? ' · your treasury is short' : ''}.` : ''}
        </p>
      )}

      {protectedBy && (
        <div style={{ marginTop: '.7rem', padding: '.6rem .8rem', borderRadius: 10, background: 'var(--color-surface-2, #f6f1e7)', fontSize: '.84rem' }}>
          <p style={{ margin: '0 0 .4rem' }}><strong>{label} is a domain.</strong> {refusal?.need === 'verify'
            ? `${email} is not a verified email on this Home.`
            : `To claim ${label}.${tld} you need a verified email at ${protectedBy} on this Home.`}
            {' '}No such email? <a href="/security/sign-in" style={{ color: 'inherit' }}>Add one under Security</a>, verify the code, then come back.</p>
          <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder={`you@${protectedBy}`} inputMode="email" aria-label={`Your email at ${protectedBy}`} style={{ ...inputSty, flex: 1, minWidth: 200 }} />
            <button style={btnSty} onClick={() => setPreview(null)} disabled={!email}>Use this email</button>
          </div>
        </div>
      )}
      {err && <p style={{ ...errorText, fontSize: '.82rem', marginTop: '.5rem' }}>{err}</p>}
    </div>
  );
}
