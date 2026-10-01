'use client';
// Security → Sign-in (spec 422 §3) — "Who can sign for you", as a LIST and never a count.
//
// Rows come from the chain joined with the vault's labels (`src/home/credentials.ts`): custody-grade rows SIGN for
// the person (passkeys, wallets, the server-held key behind a Google / email / phone home); login-grade rows only
// OPEN the home (emails, phones — the channels the home tells her on). Four ceremonies: Add, Replace, Retire,
// Graduate. There is no bare remove: retiring a credential while another is held is the ROTATION ceremony (keeps
// every standing wire, spec 410 §1.2); the "Remove a sign-in method" dialog this replaces said "connected apps are
// untouched" while a bare `removePasskey` bumps the custody epoch and voids them all (spec 408 §1.2).
//
// Every gate here is the one policy table (`canPerformSecurityAct`, packages/connect): a login-grade session gets
// the step-up INLINE at the act, never a page wall — and the grade is the server's (`sessionGrade`), not the sign-in word.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { canPerformSecurityAct, type SecurityAct } from '@agenticprimitives/connect';
import { useSession } from '../../../../src/context/session';
import { whitelabel } from '../../../../src/whitelabel/config';
import { stepUpToAgent, rotationAvailability } from '../../../../src/connect-client';
import { addCredentialCeremony, labelCredentialCeremony, recordLinkedChannel, unlinkChannelCeremony, type CeremonyCtx } from '../../../../src/home/security-ceremonies';
import { loadPasskey } from '../../../../src/lib/passkey';
import { sessionGrade } from '../../../../src/lib/security-grade';
import { reviewedList, rotateThisDevicePasskey, type ReviewedWire, type RotationOutcome } from '../../../../src/home/rotation';
import { parseMoveTicket, ticketRefToCredentialRef, type MoveTicketV1, type PasskeyCredentialRef } from '../../../../src/home/move';
import { resolveVia, signHashFor } from '../../../../src/home/onboarding';
import { emitControlEvent } from '../../../../src/home/control-plane';
import { readCredentialSet, writeCredentialLabel, retireCredentialLabel, type CredentialSet, type CredentialRow } from '../../../../src/home/credentials';
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { BasisLine } from '../../../../src/components/portal/BasisLine';
import { ApproveDevice } from '../../../../src/components/device-link';
import { EmailAuthCard } from '../../../../src/components/portal/EmailAuthCard';
import { PhoneAuthCard } from '../../../../src/components/portal/PhoneAuthCard';
import { FingerprintIcon, MailIcon, LockIcon } from '../../../../src/components/shared/Icons';
import { Dialog, Field, Row as FlexRow, Stack } from '../../../../src/components/shared/ui';
import { List, Row, Chip, Button, Note, Meta, Mono, Unknown, Empty } from '../../../../src/ui';
import { Panel } from '../../../../src/ui/panel';

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const STATE_TONE: Record<CredentialRow['state'], 'ok' | 'warn' | 'danger' | undefined> = { active: 'ok', 'pending-active': 'warn', retired: undefined, superseded: undefined, revoked: 'danger', compromised: 'danger' };
const STATE_WORDS: Record<CredentialRow['state'], string> = { active: 'signs for you', 'pending-active': 'pending', retired: 'retired', superseded: 'replaced', revoked: 'revoked', compromised: 'compromised' };

/** The inline step-up (spec 422 §3.4): a login-grade session confirming with a credential that signs. */
function StepUp({ act, onDone }: { act: SecurityAct; onDone: () => void }) {
  const { session, openSession } = useSession();
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (m: 'passkey' | 'wallet') => {
    if (!session) return;
    setMsg('Confirming…');
    try {
      const out = await stepUpToAgent(m, session.token);
      if (out.ok) { await openSession(out.token, m, false); onDone(); } else setMsg(out.error);
    } catch (e) { setMsg(e instanceof Error ? e.message : 'step-up failed'); }
  };
  return (
    <Stack gap={0.5}>
      <p className="ui-note" style={{ margin: 0 }}>This session opens your home but does not sign for it. <b>{act.replace('.', ' ')}</b> needs a credential that signs — confirm once and the act continues.</p>
      <FlexRow gap={0.5}>
        <Button variant="primary" onClick={() => void run('passkey')}>Confirm with passkey</Button>
        <Button onClick={() => void run('wallet')}>Confirm with wallet</Button>
      </FlexRow>
      {msg && <p className="onboarding-hint taken" style={{ margin: 0 }}>{msg}</p>}
    </Stack>
  );
}

export default function SignInPage() {
  const { session, profile, agentAddress } = useSession();
  const personAgent = agentAddress as Address | null;
  const via = session?.via ?? '';
  const grade = sessionGrade(profile);
  const can = (act: SecurityAct) => canPerformSecurityAct(grade, act);

  const [set, setSet] = useState<CredentialSet | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [approveOpen, setApprove] = useState(false);
  const reload = useCallback(async () => {
    if (!personAgent) return;
    try { setSet(await readCredentialSet(personAgent, { sessionCredential: profile?.credential, via })); setReadError(null); }
    catch (e) { setReadError(e instanceof Error ? e.message : 'read failed'); }
  }, [personAgent, profile?.credential, via]);
  useEffect(() => { void reload(); }, [reload]);

  // ── Add (a passkey or a wallet) ──────────────────────────────────────────────────────────────────────
  const [add, setAdd] = useState<{ open?: boolean; kind?: 'passkey' | 'wallet'; label?: string; step?: string; done?: string; error?: string }>({});
  const currentAuthorizer = () => {
    if (!personAgent || !session) throw new Error('no active session');
    return signHashFor(resolveVia(profile?.credential, via), personAgent, { token: session.token });
  };
  const ceremonyCtx = (): CeremonyCtx => { if (!personAgent || !session) throw new Error('no active session'); return { person: personAgent, session, profile, onStep: (st) => setAdd((a) => ({ ...a, step: st })) }; };
  const runAdd = async () => {
    if (!personAgent || !session || !add.kind) return;
    setAdd((a) => ({ ...a, step: 'Starting…', error: undefined }));
    try {
      const r = await addCredentialCeremony(ceremonyCtx(), { kind: add.kind, ...(add.label ? { label: add.label } : {}) });
      setAdd(r.ok ? { done: r.said } : (a) => ({ ...a, step: undefined, error: r.error }));
      if (r.ok) void reload();
    } catch (e) { setAdd((a) => ({ ...a, step: undefined, error: e instanceof Error ? e.message : 'add failed' })); }
  };

  // ── Replace this device's passkey / Move to another Home — spec 410 §1.2, unchanged ceremony ───────────
  const [rotate, setRotate] = useState<{ open?: boolean; loading?: boolean; wires?: ReviewedWire[]; warnings?: string[]; keep?: Set<string>; label?: string; step?: string; error?: string; done?: RotationOutcome; move?: boolean; ticketText?: string; ticket?: MoveTicketV1 }>({});
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
      const old = loadPasskey();
      let addRef: { ref: PasskeyCredentialRef; home: string } | undefined;
      if (rotate.move) {
        const parsed = parseMoveTicket(rotate.ticketText ?? '', { agent: personAgent, origin: window.location.origin });
        if (!parsed.ok) { setRotate((x) => ({ ...x, step: undefined, error: parsed.error })); return; }
        addRef = { ref: ticketRefToCredentialRef(parsed.ticket.ref), home: new URL(parsed.ticket.home).origin };
      }
      const r = await rotateThisDevicePasskey({ person: personAgent, session: { token: session.token }, signHash, wires: rotate.wires, keep: rotate.keep ?? new Set(), label: rotate.label || 'My passkey', onStep: (step) => setRotate((x) => ({ ...x, step })), ...(addRef ? { add: addRef } : {}) });
      if (!r.ok) { setRotate((x) => ({ ...x, step: undefined, error: r.error })); return; }
      // The labels follow the chain: the old passkey is superseded, the new one labelled.
      if (old) await retireCredentialLabel(personAgent, { kind: 'passkey', credentialIdDigest: old.credentialIdDigest }, 'superseded').catch(() => {});
      const fresh = addRef ? null : loadPasskey();
      if (fresh) await writeCredentialLabel(personAgent, { ref: { kind: 'passkey', credentialIdDigest: fresh.credentialIdDigest }, label: rotate.label || 'My passkey', device: 'This device', createdAt: new Date().toISOString() }).catch(() => {});
      if (addRef) await writeCredentialLabel(personAgent, { ref: { kind: 'passkey', credentialIdDigest: addRef.ref.credentialIdDigest }, label: `Passkey at ${addRef.home}`, device: addRef.home, createdAt: new Date().toISOString() }).catch(() => {});
      void emitControlEvent(session.token, 'credential-retired');
      void emitControlEvent(session.token, 'credential-added');
      setRotate((x) => ({ ...x, step: undefined, done: r.outcome }));
      void reload();
    } catch (e) { setRotate((x) => ({ ...x, step: undefined, error: e instanceof Error ? e.message : 'rotation failed' })); }
  };

  // ── Rename ───────────────────────────────────────────────────────────────────────────────────────────
  const [rename, setRename] = useState<{ row?: CredentialRow; label?: string; error?: string }>({});
  const runRename = async () => {
    if (!personAgent || !rename.row?.ref) return;
    try {
      await labelCredentialCeremony({ person: personAgent }, { ref: rename.row.ref, label: (rename.label ?? '').trim() || rename.row.label, ...(rename.row.createdAt ? { createdAt: rename.row.createdAt } : {}) });
      setRename({}); void reload();
    } catch (e) { setRename((r) => ({ ...r, error: e instanceof Error ? e.message : 'rename failed' })); }
  };

  // ── Channels ─────────────────────────────────────────────────────────────────────────────────────────
  const [channel, setChannel] = useState<{ open?: 'email' | 'phone' }>({});
  const [unlink, setUnlink] = useState<{ row?: CredentialRow; step?: string; error?: string }>({});
  const onLinked = (kind: 'email' | 'phone') => async (value: string) => {
    if (!personAgent || !session) return;
    await recordLinkedChannel({ person: personAgent, session, profile }, { kind, value });
    setChannel({}); void reload();
  };
  const runUnlink = async () => {
    const row = unlink.row; const c = row?.channel;
    if (!personAgent || !session || !row || !c) return;
    setUnlink((u) => ({ ...u, step: 'Unlinking…', error: undefined }));
    try {
      const r = await unlinkChannelCeremony({ person: personAgent, session, profile }, { kind: c.kind, value: c.value });
      if (!r.ok) throw new Error(r.error);
      setUnlink({}); void reload();
    } catch (e) { setUnlink((u) => ({ ...u, step: undefined, error: e instanceof Error ? e.message : 'unlink failed' })); }
  };

  // ── Derived facts the page says ──────────────────────────────────────────────────────────────────────
  const rows = set?.rows ?? [];
  const custody = rows.filter((r) => r.grade === 'custody-grade' && r.state === 'active');
  const channels = rows.filter((r) => r.grade === 'login-grade');
  const retired = rows.filter((r) => r.grade === 'custody-grade' && r.state !== 'active');
  const total = set ? set.counts.passkeys + set.counts.custodians : null;
  const rotationOk = rotationAvailability();
  const thisDevicePasskey = via.toLowerCase() === 'passkey' && !!loadPasskey();
  const serverKeyOnly = set ? set.counts.passkeys === 0 && set.counts.custodians === 1 && custody.some((r) => r.kind === 'server-key') : false;
  // A channel that IS the way into a server-key-only home cannot be unlinked (it is how she opens the home).
  const channelIsTheDoor = (r: CredentialRow): boolean => serverKeyOnly && !!r.channel && via.toLowerCase() === r.channel.kind;
  const custodyGoverned = (set?.custodyMode ?? 0) > 0;
  const panelState = readError ? 'unknown' : !set ? 'loading' : rows.length === 0 && set.unlabelled.passkeys + set.unlabelled.custodians === 0 ? 'empty' : 'ready';

  const retireReason = custodyGoverned
    ? 'this home is custody-governed — its credentials change through the custody policy under your trustees\' quorum'
    : !rotationOk.ok ? rotationOk.reason : undefined;

  return (
    <SectionShell
      title="Sign-in"
      description="Which credentials open this home and sign for it, on which devices — and the emails and phones we tell when something changes."
      actions={<FlexRow gap={0.5}>
        <Button variant="primary" onClick={() => setAdd({ open: true, kind: 'passkey', label: 'Passkey' })} disabled={!session}>Add a passkey</Button>
        <Button onClick={() => setAdd({ open: true, kind: 'wallet', label: 'Wallet' })} disabled={!session}>Add a wallet</Button>
      </FlexRow>}
    >
      <BasisLine needs="a credential that signs for you" />

      {/* ── Signs for you ───────────────────────────────────────────────────────────────────────────── */}
      <Panel
        title="Signs for you"
        icon={<FingerprintIcon size={18} />}
        count={custody.length}
        state={panelState}
        aside={total != null && set ? <Meta>{total} on chain{set.unlabelled.passkeys + set.unlabelled.custodians > 0 ? ` · ${set.unlabelled.passkeys + set.unlabelled.custodians} unlabelled` : ''}{custodyGoverned ? ' · custody-governed' : ''}</Meta> : undefined}
        unknown={{ read: readError ?? 'your credentials' }}
        empty={{ title: 'Nothing signs for this home', hint: 'A chain read answered with no custodian and no passkey — this home cannot act until one is added.' }}
        testId="sec-custody"
      >
        <List>
          {custody.map((r) => (
            <Row
              key={r.key}
              title={<span>{r.label} {r.thisDevice && <Chip tone="ok">this device</Chip>}</span>}
              meta={<span>{r.sub}{r.ref?.kind === 'custodian' ? <> · <Mono title={r.ref.address}>{shortAddr(r.ref.address)}</Mono></> : null}{r.createdAt ? ` · since ${new Date(r.createdAt).toLocaleDateString()}` : ''}</span>}
              side={<FlexRow gap={0.4}>
                <Chip tone={STATE_TONE[r.state]}>{STATE_WORDS[r.state]}</Chip>
                <Button size="sm" onClick={() => setRename({ row: r, label: r.label })}>Rename</Button>
                {r.kind === 'passkey' && r.thisDevice && thisDevicePasskey && (
                  <Button size="sm" onClick={() => void openRotation(false)} disabled={!!retireReason} title={retireReason}>Replace</Button>
                )}
                {r.kind === 'server-key' && (
                  <Button size="sm" disabled title={retireReason ?? 'Graduate: add a passkey and retire this server-held key in one signature — every grant kept (spec 235 §7). Available once this estate runs contracts generation 3.'}>Graduate</Button>
                )}
                {r.kind !== 'server-key' && !(r.kind === 'passkey' && r.thisDevice) && (
                  <Button size="sm" disabled title={retireReason ?? 'Retire: re-approves every grant under your surviving credential in one signature (spec 410 §1.2). Available once this estate runs contracts generation 3.'}>Retire</Button>
                )}
              </FlexRow>}
              dataState={r.state}
              testId={`sec-cred-${r.kind}`}
            />
          ))}
          {set && set.unlabelled.passkeys + set.unlabelled.custodians > 0 && (
            <Row title={<span>Unlabelled</span>} meta={<span>{set.unlabelled.passkeys > 0 ? `${set.unlabelled.passkeys} passkey${set.unlabelled.passkeys === 1 ? '' : 's'}` : ''}{set.unlabelled.passkeys > 0 && set.unlabelled.custodians > 0 ? ' and ' : ''}{set.unlabelled.custodians > 0 ? `${set.unlabelled.custodians} custodian key${set.unlabelled.custodians === 1 ? '' : 's'}` : ''} the chain holds that this Home has no label for — added from another device or before labels existed. They sign for you all the same.</span>} testId="sec-unlabelled" />
          )}
        </List>
        {set && set.unknown.length > 0 && <Unknown read={set.unknown.join(', ')} partial />}
        {total === 1 && <Note>One credential opens this home. Lose it and nothing can bring it back — add a second of another kind.</Note>}
        {thisDevicePasskey && !custodyGoverned && (
          <FlexRow gap={0.5} style={{ marginTop: '.5rem' }}>
            <Button size="sm" onClick={() => setApprove(true)}>Add another device</Button>
            <Button size="sm" onClick={() => void openRotation(true)} disabled={!rotationOk.ok} title={rotationOk.ok ? undefined : rotationOk.reason}>Move to another Home</Button>
          </FlexRow>
        )}
        {!rotationOk.ok && !custodyGoverned && <Note>Replace, Retire, Graduate and Move need the rotation ceremony (spec 410 §1.2), which keeps every grant you issued. {rotationOk.reason}. Adding a credential works today; nothing here will quietly remove one.</Note>}
      </Panel>

      {/* ── Opens this home ─────────────────────────────────────────────────────────────────────────── */}
      <Panel
        title="Opens this home"
        icon={<MailIcon size={18} />}
        count={channels.length}
        state={!set ? 'loading' : channels.length === 0 ? 'empty' : 'ready'}
        aside={<FlexRow gap={0.4}>
          <Button size="sm" onClick={() => setChannel({ open: 'email' })} disabled={!session}>Add email</Button>
          <Button size="sm" onClick={() => setChannel({ open: 'phone' })} disabled={!session}>Add phone</Button>
        </FlexRow>}
        empty={{ title: 'No email or phone linked', hint: 'An email or phone opens this home and is where we tell you when a credential or a recovery changes. It never signs for you.' }}
        testId="sec-channels"
      >
        <List>
          {channels.map((r) => (
            <Row
              key={r.key}
              title={r.label}
              meta={<span>{r.sub} · opens this home · told about changes</span>}
              side={<Button size="sm" variant="danger" onClick={() => setUnlink({ row: r })} disabled={channelIsTheDoor(r)} title={channelIsTheDoor(r) ? 'This is how you open this home — add a passkey first, then unlink it.' : undefined}>Unlink</Button>}
              testId={`sec-channel-${r.kind}`}
            />
          ))}
        </List>
        <Note>An email or phone is a <b>channel</b>: it opens this home and is told about changes so you can stop one that was not you. It never signs for you, never approves anything, and is never a way to recover this home.</Note>
      </Panel>

      {/* ── Retired ─────────────────────────────────────────────────────────────────────────────────── */}
      {retired.length > 0 && (
        <Panel title="Retired" icon={<LockIcon size={18} />} count={retired.length} state="ready" testId="sec-retired">
          <List>
            {retired.map((r) => (
              <Row key={r.key} title={r.label} meta={<span>{r.sub}{r.createdAt ? ` · since ${new Date(r.createdAt).toLocaleDateString()}` : ''}</span>} side={<Chip tone={STATE_TONE[r.state]}>{STATE_WORDS[r.state]}</Chip>} dataState={r.state} />
            ))}
          </List>
        </Panel>
      )}

      {/* ── Dialogs ─────────────────────────────────────────────────────────────────────────────────── */}
      <Dialog open={!!add.open} onClose={() => { if (!add.step) setAdd({}); }} title={add.kind === 'wallet' ? 'Add a wallet' : 'Add a passkey'} description="A second credential of another kind is what makes a lost device survivable. Adding one changes nothing you have granted (spec 408 §1.2): your address, your name and every grant stay as they are. You can also say “add a passkey” to your agent.">
        {add.done ? (
          <Stack gap={0.5}><p className="onboarding-hint ok">✓ {add.done}.</p><FlexRow gap={0.5} justify="flex-end"><Button variant="primary" onClick={() => setAdd({})}>Done</Button></FlexRow></Stack>
        ) : !can('credential.add').ok ? (
          <StepUp act="credential.add" onDone={() => { /* the session re-opened custody-grade; the dialog stays */ }} />
        ) : add.step ? (
          <FlexRow gap={0.4} className="muted"><span className="spinner" /> {add.step}</FlexRow>
        ) : (
          <Stack gap={0.6}>
            <Field label={add.kind === 'wallet' ? 'Name for this wallet' : 'Name for this passkey'} hint="Shown in your list — the device or the wallet it lives in.">
              <input className="onboarding-input" value={add.label ?? ''} onChange={(e) => setAdd((a) => ({ ...a, label: e.target.value }))} />
            </Field>
            <p className="ui-note" style={{ margin: 0 }}>Signed by: one of the credentials that signs for you now{via ? ` (your ${via.toLowerCase()} sign-in)` : ''}.</p>
            <FlexRow gap={0.5} justify="flex-end">
              <Button onClick={() => setAdd({})}>Cancel</Button>
              <Button variant="primary" onClick={() => void runAdd()}>{add.kind === 'wallet' ? 'Connect and add' : 'Create and add'}</Button>
            </FlexRow>
          </Stack>
        )}
        {add.error && <p className="onboarding-hint taken" style={{ marginTop: '.5rem' }}>{add.error}</p>}
      </Dialog>

      <Dialog open={!!approveOpen} onClose={() => setApprove(false)} title="Add another device" description="Approve a passkey created on another device — it becomes a credential that signs for you there. Your address, name and grants are unchanged.">
        <ApproveDevice onApproved={() => { setApprove(false); void reload(); }} />
      </Dialog>

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
            <FlexRow gap={0.5} justify="flex-end"><Button variant="primary" onClick={() => setRotate({})}>Done</Button></FlexRow>
          </Stack>
        ) : !can('credential.replace').ok ? (
          <StepUp act="credential.replace" onDone={() => {}} />
        ) : rotate.step ? (
          <FlexRow gap={0.4} className="muted"><span className="spinner" /> {rotate.step}</FlexRow>
        ) : rotate.loading ? (
          <FlexRow gap={0.4} className="muted"><span className="spinner" /> Reading everything you have granted…</FlexRow>
        ) : !rotationOk.ok ? (
          <p className="muted" style={{ fontSize: '.85rem' }}>{(rotationOk as { ok: false; reason: string }).reason}</p>
        ) : (
          <Stack gap={0.6}>
            {rotate.move ? (
              <Field label="The other Home’s ticket" hint="Pasted from “Move your Home here” at the other Home. It carries a public key and nothing secret.">
                <textarea className="onboarding-input" rows={3} value={rotate.ticketText ?? ''} onChange={(e) => setRotate((x) => ({ ...x, ticketText: e.target.value, error: undefined }))} placeholder="ap.home-move-ticket…" />
              </Field>
            ) : (
              <Field label="Name for the new passkey" hint="Shown in your list of sign-in credentials.">
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
                    <span style={{ fontSize: '.85rem' }}><b>{w.holderName ?? shortAddr(w.holder)}</b> <span className="muted">· {w.kind}</span><br /><span className="muted">{w.what}{w.signed === 'key' ? ' · re-issued under the new key' : ''}</span></span>
                  </li>
                ))}
              </ul>
            </div>
            {(rotate.warnings ?? []).map((w, i) => <p key={i} className="muted" style={{ fontSize: '.8rem', margin: 0 }}>{w}</p>)}
            <p className="ui-note" style={{ margin: 0 }}>Signed by: the passkey being retired, as its last act. What does not change: your address, your name, your records.</p>
            <FlexRow gap={0.5} justify="flex-end">
              <Button onClick={() => setRotate({})}>Cancel</Button>
              <Button variant="primary" disabled={!!rotate.move && !(rotate.ticketText ?? '').trim()} onClick={() => void runRotation()}>{rotate.move ? 'Move (sign once here)' : 'Replace passkey'}</Button>
            </FlexRow>
          </Stack>
        )}
        {rotate.error && <p className="onboarding-hint taken" style={{ marginTop: '.5rem' }}>{rotate.error}</p>}
      </Dialog>

      <Dialog open={!!rename.row} onClose={() => setRename({})} title="Rename" description="A label in your vault — the chain only knows the key.">
        <Stack gap={0.6}>
          <Field label="Name"><input className="onboarding-input" value={rename.label ?? ''} onChange={(e) => setRename((r) => ({ ...r, label: e.target.value }))} /></Field>
          <FlexRow gap={0.5} justify="flex-end"><Button onClick={() => setRename({})}>Cancel</Button><Button variant="primary" onClick={() => void runRename()}>Save</Button></FlexRow>
          {rename.error && <p className="onboarding-hint taken" style={{ margin: 0 }}>{rename.error}</p>}
        </Stack>
      </Dialog>

      <Dialog open={!!channel.open} onClose={() => setChannel({})} title={channel.open === 'phone' ? 'Add a phone' : 'Add an email'} description={channel.open === 'phone' ? 'You’ll verify a code we text you. The phone opens this home and is told about changes; it never signs for you and never approves anything.' : 'You’ll verify a 6-digit code we send you. The email opens this home and is told about changes; it never signs for you.'}>
        {channel.open === 'phone' ? <PhoneAuthCard onLinked={onLinked('phone')} /> : <EmailAuthCard onLinked={onLinked('email')} />}
      </Dialog>

      <Dialog open={!!unlink.row} onClose={() => { if (!unlink.step) setUnlink({}); }} title={`Unlink ${unlink.row?.label?.toLowerCase() ?? 'channel'}`} description="It stops opening this home and stops being told about changes. Nothing on chain changes — a channel never signed for you.">
        {unlink.step ? <FlexRow gap={0.4} className="muted"><span className="spinner" /> {unlink.step}</FlexRow> : (
          <FlexRow gap={0.5} justify="flex-end"><Button onClick={() => setUnlink({})}>Cancel</Button><Button variant="danger" onClick={() => void runUnlink()}>Unlink {unlink.row?.sub}</Button></FlexRow>
        )}
        {unlink.error && <p className="onboarding-hint taken" style={{ marginTop: '.5rem' }}>{unlink.error}</p>}
      </Dialog>

      {!whitelabel.services.devices && <Empty title="Sign-in management is off for this deployment" />}
    </SectionShell>
  );
}
