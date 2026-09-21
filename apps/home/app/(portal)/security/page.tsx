'use client';
// Security & Recovery — sign-in methods, linked devices, recovery. Reuses the existing
// add-credential + cross-device-link primitives. Recovery (trustees/guardians) is coming soon.
import { useEffect, useState } from 'react';
import type { Address, Hex } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { whitelabel } from '../../../src/whitelabel/config';
import {
  addWalletCredential,
  addPasskeyCredential,
  removeWalletCredential,
  removePasskeyCredential,
  readCredentialCounts,
  stepUpToAgent,
} from '../../../src/connect-client';
import { loadPasskey } from '../../../src/lib/passkey';
import { reviewedList, rotateThisDevicePasskey, type ReviewedWire, type RotationOutcome } from '../../../src/home/rotation';
import { parseMoveTicket, ticketRefToCredentialRef, type MoveTicketV1, type PasskeyCredentialRef } from '../../../src/home/move';
import { rotationAvailability } from '../../../src/connect-client';
import { resolveVia, signHashFor } from '../../../src/home/onboarding';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { ComingSoonState } from '../../../src/components/portal/ComingSoonState';
import { DeviceRow } from '../../../src/components/portal/DeviceRow';
import { ApproveDevice } from '../../../src/components/device-link';
import { DelegationsList } from '../../../src/components/portal/DelegationsList';
import { GoogleSignInPanel } from '../../../src/components/portal/settings/GoogleSignInPanel';
import { EmailAuthCard } from '../../../src/components/portal/EmailAuthCard';
import { PhoneAuthCard } from '../../../src/components/portal/PhoneAuthCard';
import { FingerprintIcon, MonitorIcon, ShieldIcon } from '../../../src/components/shared/Icons';
import { Dialog, Field, Row, Stack } from '../../../src/components/shared/ui';

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// Label the CURRENT sign-in method by its credential. A KMS/social home (phone/email/google) has an
// EOA-shaped C_sub custodian on-chain, so the raw custodian count reads as "wallets" — but the method the
// member actually used is their phone/email/etc. Show that, not "Wallet".
const CRED_LABEL: Record<string, string> = { passkey: 'Passkey', wallet: 'Wallet', phone: 'Phone (SMS)', email: 'Email', google: 'Google', youversion: 'YouVersion' };
const credLabel = (via: string): string => CRED_LABEL[via.toLowerCase()] ?? 'Sign-in key';
const isKmsLabel = (via: string): boolean => ['phone', 'email', 'google', 'youversion'].includes(via.toLowerCase());

// Index the passkey → home mapping so passkey sign-in resolves THIS home (a KMS/social home's SA is not
// derived from the passkey). Best-effort with a short retry: the add userOp just mined, but the link route
// re-reads `hasPasskey` on-chain and 409s until the RPC sees it.
async function linkPasskeyToHome(agent: Address, credentialIdDigest: Hex, token: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch('/connect/passkey/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ credentialIdDigest, agent }),
      });
      if (r.ok || r.status !== 409) return; // 409 = not mined yet → retry; anything else is terminal
    } catch { /* network hiccup — retry */ }
    await new Promise((res) => setTimeout(res, 2500));
  }
}

export default function SecurityPage() {
  const { session, profile, agentAddress, openSession } = useSession();
  const via = session?.via ?? '';
  const [add, setAdd] = useState<{ step?: string; done?: string; error?: string } | null>(null);
  const [showApprove, setShowApprove] = useState(false);
  const [stepUpMsg, setStepUpMsg] = useState<string | null>(null);
  // Spec 410 §1.2 — the rotation ceremony: replace this device's passkey and keep every standing wire.
  const [rotate, setRotate] = useState<{ open?: boolean; loading?: boolean; wires?: ReviewedWire[]; warnings?: string[]; keep?: Set<string>; label?: string; step?: string; error?: string; done?: RotationOutcome;
    /** Spec 410 §1.2 step 5 — a MOVE: the new passkey comes from another Home's ticket, pasted here. */
    move?: boolean; ticketText?: string; ticket?: MoveTicketV1 }>({});

  // Google = login-grade. Managing security needs a custody credential → step up first.
  if (via === 'Google') {
    const stepUp = async (m: 'passkey' | 'wallet') => {
      if (!session) return;
      setStepUpMsg('Confirming…');
      try {
        const out = await stepUpToAgent(m, session.token);
        if (out.ok) await openSession(out.token, m, false);
        else setStepUpMsg(out.error);
      } catch (e) {
        setStepUpMsg(e instanceof Error ? e.message : 'step-up failed');
      }
    };
    return (
      <SectionShell title="Security & Recovery" description="Confirm with a custody credential to manage your sign-in methods.">
        <div className="agent-identity-card">
          <p className="onboarding-sub">You&apos;re signed in with Google (sign-in only). Confirm with your passkey or wallet to manage security.</p>
          <button className="btn-primary" onClick={() => stepUp('passkey')}>Continue with passkey</button>
          <button className="btn-ghost" onClick={() => stepUp('wallet')}>Continue with wallet</button>
          {stepUpMsg && <p className="onboarding-hint taken">{stepUpMsg}</p>}
        </div>
      </SectionShell>
    );
  }

  const personAgent = agentAddress as Address | null;
  const [counts, setCounts] = useState<{ custodians: number; passkeys: number } | null>(null);
  const [remove, setRemove] = useState<{ open?: boolean; addr?: string; step?: string; done?: string; error?: string }>({});

  // Live credential set (view call). Re-read after an add/remove completes.
  useEffect(() => {
    if (!personAgent || via === 'Google') return;
    let live = true;
    readCredentialCounts(personAgent).then((c) => live && setCounts(c)).catch(() => {});
    return () => { live = false; };
  }, [personAgent, via, add?.done, remove.done]);

  const total = counts ? counts.custodians + counts.passkeys : null;
  const canRemove = total != null && total > 1; // the contract refuses the last one too

  // The agent's CURRENT custodian signs every credential change — resolved from the home's ACTUAL
  // on-chain credential (a wallet home → MetaMask; a KMS/Google/email home → server-side, no prompt),
  // NEVER the raw session `via` (which popped MetaMask for KMS homes, which have no wallet custodian).
  const currentAuthorizer = () => {
    if (!personAgent || !session) throw new Error('no active session');
    return signHashFor(resolveVia(profile?.credential, via), personAgent, { token: session.token });
  };

  const addComplementary = async () => {
    if (!personAgent || !session) return;
    setAdd({ step: 'Starting…' });
    try {
      const onStep = (s: string) => setAdd({ step: s });
      const authorizer = await currentAuthorizer();
      if (via === 'passkey') {
        const r = await addWalletCredential(personAgent, authorizer, onStep);
        setAdd(r.ok ? { done: `Wallet ${shortAddr(r.added)} added` } : { error: r.error });
      } else {
        const r = await addPasskeyCredential(personAgent, authorizer, onStep);
        if (r.ok) {
          // Index passkey → home so signing in with it later resolves THIS (KMS/social) home, not the
          // passkey-derived address (otherwise the recovery passkey opens the wrong/no home).
          onStep('Linking the passkey to your home…');
          await linkPasskeyToHome(personAgent, r.credentialIdDigest, session.token);
          setAdd({ done: 'Passkey added' });
        } else setAdd({ error: r.error });
      }
    } catch (e) {
      setAdd({ error: e instanceof Error ? e.message : 'add failed' });
    }
  };

  // Spec 410 §1.2 — open the ceremony: compute the reviewed list from the agent's audit + the Home's app grants.
  const openRotation = async (move = false) => {
    if (!personAgent || !session) return;
    setRotate({ open: true, loading: true, move, label: `${profile?.name ?? 'My'} passkey (${new Date().toISOString().slice(0, 10)})` });
    const r = await reviewedList({ person: personAgent, session: { token: session.token } });
    if (!r.ok) { setRotate((x) => ({ ...x, loading: false, error: r.error })); return; }
    setRotate((x) => ({ ...x, loading: false, wires: r.wires, warnings: r.warnings, keep: new Set(r.wires.map((w) => w.digest.toLowerCase())) }));
  };
  const toggleKeep = (digest: string) => setRotate((x) => { const keep = new Set(x.keep ?? []); const k = digest.toLowerCase(); if (keep.has(k)) keep.delete(k); else keep.add(k); return { ...x, keep }; });
  const runRotation = async () => {
    if (!personAgent || !session || !rotate.wires) return;
    setRotate((x) => ({ ...x, step: 'Starting…', error: undefined }));
    try {
      const signHash = await currentAuthorizer();
      // Spec 410 §1.2 step 5 — a move: the ticket's passkey is added instead of one created here.
      let add: { ref: PasskeyCredentialRef; home: string } | undefined;
      if (rotate.move) {
        const parsed = parseMoveTicket(rotate.ticketText ?? '', { agent: personAgent, origin: window.location.origin });
        if (!parsed.ok) { setRotate((x) => ({ ...x, step: undefined, error: parsed.error })); return; }
        add = { ref: ticketRefToCredentialRef(parsed.ticket.ref), home: new URL(parsed.ticket.home).origin };
      }
      const r = await rotateThisDevicePasskey({ person: personAgent, session: { token: session.token }, signHash, wires: rotate.wires, keep: rotate.keep ?? new Set(), label: rotate.label || 'My passkey', onStep: (step) => setRotate((x) => ({ ...x, step })), ...(add ? { add } : {}) });
      if (r.ok) { setRotate((x) => ({ ...x, step: undefined, done: r.outcome })); readCredentialCounts(personAgent).then(setCounts).catch(() => {}); }
      else setRotate((x) => ({ ...x, step: undefined, error: r.error }));
    } catch (e) {
      setRotate((x) => ({ ...x, step: undefined, error: e instanceof Error ? e.message : 'rotation failed' }));
    }
  };

  // Removal uses the CURRENT credential to sign `execute(self, removeX)`. The contract blocks
  // removing your last method, so you can't lock yourself out (CannotRemoveLastCustodian).
  const removeWallet = async () => {
    const addr = (remove.addr ?? '').trim();
    if (!personAgent || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      setRemove((r) => ({ ...r, error: 'Enter a valid 0x wallet address.' }));
      return;
    }
    setRemove((r) => ({ ...r, step: 'Confirm with your current sign-in…', error: undefined }));
    try {
      const signHash = await currentAuthorizer();
      const res = await removeWalletCredential(personAgent, addr as Address, signHash);
      setRemove(res.ok ? { done: `Wallet ${shortAddr(addr)} removed` } : { open: true, addr, error: res.error });
    } catch (e) {
      setRemove({ open: true, addr, error: e instanceof Error ? e.message : 'remove failed' });
    }
  };
  const removeThisDevice = async () => {
    const pk = loadPasskey();
    if (!personAgent || !pk) return;
    setRemove((r) => ({ ...r, step: 'Removing this device…', error: undefined }));
    try {
      const signHash = await currentAuthorizer();
      const res = await removePasskeyCredential(personAgent, pk.credentialIdDigest, signHash);
      setRemove(res.ok ? { done: 'This device’s passkey was removed' } : { open: true, error: res.error });
    } catch (e) {
      setRemove({ open: true, error: e instanceof Error ? e.message : 'remove failed' });
    }
  };

  return (
    <SectionShell
      title="Security & Recovery"
      description="Your portal is protected by your device's biometrics. Manage your sign-in methods and linked devices here."
    >
      <div className="dash-section">
        <h2>Sign-in methods</h2>
        <DeviceRow
          icon={<FingerprintIcon size={20} />}
          name={credLabel(via)}
          sub={via === 'passkey' ? 'This device' : isKmsLabel(via) ? 'Verified sign-in (server-secured key)' : 'Connected wallet'}
          isThisDevice={via === 'passkey'}
        />
        {total != null && (
          <p className="muted" style={{ marginTop: '.4rem', fontSize: '.85rem' }}>
            {total} {total === 1 ? 'method' : 'methods'} open this home
            {counts ? ` — ${counts.passkeys} passkey${counts.passkeys === 1 ? '' : 's'}, ${counts.custodians} custodian key${counts.custodians === 1 ? '' : 's'}` : ''}.
            {isKmsLabel(via) && ' Your phone/email sign-in is one of the custodian keys (a server-held key, not a wallet).'}
            {total === 1 && ' Add another so you’re never locked out.'}
          </p>
        )}
        {add?.done ? (
          <p className="onboarding-hint ok" style={{ marginTop: '.5rem' }}>✓ {add.done} — same agent, same details.</p>
        ) : add?.step ? (
          <Row gap={0.4} className="muted" style={{ marginTop: '.5rem' }}><span className="spinner" /> {add.step}</Row>
        ) : (
          <button className="btn-ghost" style={{ marginTop: '.65rem' }} onClick={addComplementary}>
            {via === 'passkey' ? 'Add a wallet' : 'Add a passkey'}
          </button>
        )}
        {add?.error && <p className="onboarding-hint taken" style={{ marginTop: '.5rem' }}>{add.error}</p>}

        {/* Spec 410 §1.2 — ROTATION: replace this device's passkey and keep every standing wire, in one signature.
            Distinct from "remove" below: a removal alone voids every wire (the custody epoch, spec 408); the
            ceremony re-approves them under the new epoch in the same transaction. */}
        {via === 'passkey' && loadPasskey() && !rotate.open && (
          <>
            <button className="btn-ghost onboarding-secondary" style={{ marginTop: '.4rem', marginLeft: '.5rem' }} onClick={() => void openRotation(false)}>
              Replace this device’s passkey
            </button>
            {/* Spec 410 §1.2 step 5 — a Home-to-Home move IS this ceremony with the new key from the other Home. */}
            <button className="btn-ghost onboarding-secondary" style={{ marginTop: '.4rem', marginLeft: '.5rem' }} onClick={() => void openRotation(true)}>
              Move to another Home
            </button>
          </>
        )}
        <Dialog
          open={!!rotate.open}
          onClose={() => { if (!rotate.step) setRotate({}); }}
          title={rotate.move ? 'Move to another Home' : 'Replace this device’s passkey'}
          description={rotate.move
            ? 'At the other Home, open “Move your Home here”, create a passkey there and paste its ticket below. One signature here adds that passkey, retires this device’s, and re-approves everything you have granted — so nothing you connected has to reconnect. It is not a recovery: nothing was lost, and the other Home is trusted with a public key and nothing else.'
            : 'A new passkey is created on this device and the old one retired. Everything you have granted — apps, your agent’s planes, contacts — is re-approved under the new key in the same signature, so nothing you connected has to reconnect. Untick anything you want to stop.'}
        >
          {rotate.done ? (
            <Stack gap={0.5}>
              <p className="onboarding-hint ok">✓ {rotate.done.movedTo ? `Moved — sign in at ${rotate.done.movedTo} with the passkey you created there` : 'Passkey replaced'} — {rotate.done.reapproved} grant{rotate.done.reapproved === 1 ? '' : 's'} re-approved{rotate.done.reissued ? `, ${rotate.done.reissued} re-issued` : ''}{rotate.done.struck ? `, ${rotate.done.struck} revoked` : ''}. Your agent, name and connected apps are unchanged.</p>
              {rotate.done.warnings.map((w, i) => <p key={i} className="onboarding-hint taken" style={{ fontSize: '.85rem' }}>{w}</p>)}
              <Row gap={0.5} justify="flex-end"><button className="btn-primary" style={{ width: 'auto' }} onClick={() => setRotate({})}>Done</button></Row>
            </Stack>
          ) : rotate.step ? (
            <Row gap={0.4} className="muted"><span className="spinner" /> {rotate.step}</Row>
          ) : rotate.loading ? (
            <Row gap={0.4} className="muted"><span className="spinner" /> Reading everything you have granted…</Row>
          ) : !rotationAvailability().ok ? (
            <p className="muted" style={{ fontSize: '.85rem' }}>{(rotationAvailability() as { ok: false; reason: string }).reason}</p>
          ) : (
            <Stack gap={0.6}>
              {rotate.move ? (
                <Field label="The other Home’s ticket" hint="Pasted from “Move your Home here” at the other Home. It carries a public key and nothing secret.">
                  <textarea className="onboarding-input" rows={3} value={rotate.ticketText ?? ''} onChange={(e) => setRotate((x) => ({ ...x, ticketText: e.target.value, error: undefined }))} placeholder="ap.home-move-ticket…" />
                </Field>
              ) : (
                <Field label="Name for the new passkey" hint="Shown in your list of sign-in methods.">
                  <input className="onboarding-input" value={rotate.label ?? ''} onChange={(e) => setRotate((x) => ({ ...x, label: e.target.value }))} />
                </Field>
              )}
              <div>
                <p style={{ fontSize: '.85rem', margin: '0 0 .35rem' }}><b>Grants that will be kept</b> ({rotate.keep?.size ?? 0} of {rotate.wires?.length ?? 0})</p>
                {(rotate.wires ?? []).length === 0 && <p className="muted" style={{ fontSize: '.85rem' }}>You have not granted anything your agent can enumerate.</p>}
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: '16rem', overflowY: 'auto' }}>
                  {(rotate.wires ?? []).map((w) => (
                    <li key={w.digest} style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-start', padding: '.3rem 0', borderBottom: '1px solid var(--line, #eee)' }}>
                      <input type="checkbox" checked={rotate.keep?.has(w.digest.toLowerCase()) ?? false} onChange={() => toggleKeep(w.digest)} style={{ marginTop: '.2rem' }} />
                      <span style={{ fontSize: '.85rem' }}>
                        <b>{w.holderName ?? shortAddr(w.holder)}</b> <span className="muted">· {w.kind}</span><br />
                        <span className="muted">{w.what}{w.signed === 'key' ? ' · re-issued under the new key' : ''}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              {(rotate.warnings ?? []).map((w, i) => <p key={i} className="muted" style={{ fontSize: '.8rem', margin: 0 }}>{w}</p>)}
              <Row gap={0.5} justify="flex-end">
                <button className="btn-ghost onboarding-secondary" onClick={() => setRotate({})}>Cancel</button>
                <button className="btn-primary" style={{ width: 'auto' }} disabled={!!rotate.move && !(rotate.ticketText ?? '').trim()} onClick={runRotation}>{rotate.move ? 'Move (sign once here)' : 'Replace passkey'}</button>
              </Row>
            </Stack>
          )}
          {rotate.error && <p className="onboarding-hint taken" style={{ marginTop: '.5rem' }}>{rotate.error}</p>}
        </Dialog>

        {/* Remove (replace a lost device) — symmetric onlySelf op, signed by the current credential.
            A destructive action → a focus-trapped Dialog (shared/ui) rather than an inline block. */}
        {remove.done ? (
          <p className="onboarding-hint ok" style={{ marginTop: '.75rem' }}>✓ {remove.done} — your home and name are unchanged.</p>
        ) : (
          <button className="btn-ghost onboarding-secondary" style={{ marginTop: '.4rem' }} onClick={() => setRemove({ open: true })}>
            Remove a sign-in method
          </button>
        )}
        <Dialog
          open={!!remove.open}
          onClose={() => setRemove({})}
          title="Remove a sign-in method"
          description="Removing a method revokes its access immediately. Your home, name, and connected apps are untouched."
        >
          {remove.step ? (
            <Row gap={0.4} className="muted"><span className="spinner" /> {remove.step}</Row>
          ) : !canRemove ? (
            <p className="muted" style={{ fontSize: '.85rem' }}>
              This is your only sign-in method — add another first (you can’t lock yourself out).
            </p>
          ) : (
            <Stack gap={0.6}>
              <Field label="Wallet address to remove" hint="0x… — its access is revoked immediately.">
                <input
                  className="onboarding-input"
                  value={remove.addr ?? ''}
                  onChange={(e) => setRemove((r) => ({ ...r, addr: e.target.value, error: undefined }))}
                  placeholder="0x…"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </Field>
              <Row gap={0.5} justify="flex-end">
                <button className="btn-ghost onboarding-secondary" onClick={() => setRemove({})}>Cancel</button>
                <button className="btn-primary" style={{ width: 'auto' }} onClick={removeWallet}>Remove wallet</button>
              </Row>
              {via === 'passkey' && loadPasskey() && (
                <button className="btn-ghost onboarding-secondary" onClick={removeThisDevice}>
                  Remove this device’s passkey (signs you out here)
                </button>
              )}
            </Stack>
          )}
          {remove.error && <p className="onboarding-hint taken" style={{ marginTop: '.5rem' }}>{remove.error}</p>}
        </Dialog>
      </div>

      <div className="dash-section">
        <h2>Linked devices</h2>
        <DeviceRow icon={<MonitorIcon size={20} />} name="This device" sub="Signed in here" isThisDevice />
        {showApprove ? (
          <div style={{ marginTop: '.65rem' }}><ApproveDevice /></div>
        ) : (
          <button className="btn-ghost" style={{ marginTop: '.65rem' }} onClick={() => setShowApprove(true)}>
            Add another device
          </button>
        )}
      </div>

      <div className="dash-section">
        <h2>Recovery</h2>
        <ComingSoonState
          icon={<ShieldIcon size={40} />}
          title="Recovery options"
          body="Trustees and guardians who can help recover your portal if you lose access — without ever changing your identity."
        />
      </div>

      {/* Moved here from the old /you Security tab (spec 315): vault key, delegations, Google rotation. */}
      <div className="dash-section">
        <h2>Vault &amp; delegations</h2>
        <p style={{ fontSize: '.85rem', opacity: 0.75, margin: '0 0 .6rem' }}>
          Your vault encryption key and the scoped, revocable delegations you&rsquo;ve granted.
        </p>
        <a className="btn-ghost" href="/vault-key" style={{ display: 'inline-block', marginBottom: '.6rem' }}>🔒 Manage vault key</a>
        <DelegationsList token={session?.token ?? null} />
      </div>

      <GoogleSignInPanel />

      {/* Email as an added login method (email-auth Phase 1b). Login-grade only — you verify a code sent
          to your inbox; it never confers custody. */}
      <div className="dash-section">
        <h2>Email sign-in</h2>
        <p style={{ fontSize: '.85rem', opacity: 0.75, margin: '0 0 .7rem' }}>
          Add your email as a sign-in method — you&rsquo;ll verify a 6-digit code we send you. Login-grade
          (like Google); it never controls your keys.
        </p>
        <EmailAuthCard />
      </div>

      {/* Phone as an added login / recovery method (spec 320). Login-grade contact-control (SMS proves you
          hold the number); it never controls your keys — your passkey does. */}
      <div className="dash-section">
        <h2>Phone (SMS)</h2>
        <p style={{ fontSize: '.85rem', opacity: 0.75, margin: '0 0 .7rem' }}>
          Add your phone as a sign-in / recovery method — you&rsquo;ll verify a code we text you. Login-grade
          contact-control; SMS is SIM-swap-prone, so it never controls your keys or approves sensitive actions.
        </p>
        <PhoneAuthCard />
      </div>
    </SectionShell>
  );
}
