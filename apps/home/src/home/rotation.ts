// THE ROTATION CEREMONY — spec 410 §1.2 (THESIS-1). A person replaces this device's passkey and every standing wire
// she issued still validates afterwards, without any counterparty acting.
//
// Since the custody epoch (spec 408 §1.2), retiring a credential voids every approved-digest wire the account made
// and every wire the retired key signed. That is right after a compromise and unbearable after a new phone — unless
// the retirement and the re-approval are ONE transaction. This module is that transaction, and the list it is
// signed over:
//
//   1. THE REVIEWED LIST is computed, never typed: every live wire the person issued, from her agent's own audit
//      (`access.grants.audit` — the plane wires, apps, runtimes, contacts, the coach) and from the Home's `app-grants`
//      rows (the ask-as-me wires relying apps hold). Shown once, with what each permits; she may strike one.
//   2. APPROVED-DIGEST wires are re-approved as-is (`approveDigest` × N in the batch): same object, new epoch.
//   3. KEY-SIGNED wires are RE-ISSUED — same terms, same salt, the sentinel — their digests join the batch, and a
//      lineage record (`delegation.lineage:<hash>`) goes into her vault so the delegate can fetch the head.
//   4. A STRUCK wire is revoked on chain, never silently dropped.
//   5. The batch — add the new passkey → retire the old → approveDigest × N — is signed ONCE by the OLD credential,
//      its last act. Then: lineage records written, `app-grants` rows re-pointed, the new passkey linked to this Home.
//
// A RECOVERY is not this (§1.2 step 6): it re-approves nothing, and the person re-issues from the reviewed list as
// NEW grants. A custody-governed account rotates through the policy's `RotateCredential` under quorum, not here.
import type { Address, Hex } from '@agenticprimitives/types';
import { hashDelegation, reissueForRotation, lineageRecordType, wireSigning, type DelegationLineageV1, type LineageWire } from '@agenticprimitives/delegation';
import { CHAIN_ID, CONTRACTS } from '../lib/chain';
import { loadPasskey, storePasskey, type DemoPasskey } from '../lib/passkey';
import { registerPasskeyCredentialRef, rotateCredential, rotationAvailability, readCustodyMode, type SignHash } from '../connect-client';
import type { DelegationWire } from '../lib/delegation';
import { auditGrantsThroughHarness, type GrantRow } from './grants-harness';
import { ensureCsrfToken, csrfHeaders } from '../csrf';

export interface ReviewedWire {
  /** The delegation hash — what the batch approves, what a strike revokes. */
  digest: Hex;
  kind: string;
  holder: string;
  holderName?: string;
  what: string;
  /** What the rotation does with it: re-approve as-is, or re-issue with a lineage record. */
  signed: 'approved-digest' | 'key';
  /** Present when the Home holds the wire itself (an `app-grants` row); a key-signed wire needs it to be re-issued. */
  wire?: DelegationWire;
  /** The `app-grants` client the wire belongs to, when it is one. */
  clientId?: string;
  source: string;
}

const toLineageWire = (w: DelegationWire): LineageWire => ({ delegator: w.delegator, delegate: w.delegate, authority: w.authority, caveats: w.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, ...(c.args ? { args: c.args } : {}) })), salt: String(w.salt), signature: w.signature });
const digestOf = (w: DelegationWire): Hex => hashDelegation({ ...w, salt: BigInt(String(w.salt)), caveats: w.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })) }, CHAIN_ID, CONTRACTS.delegationManager);

/** The reviewed list: every LIVE wire the person issued, from both stores, de-duplicated by digest. */
export async function reviewedList(input: { person: Address; session: { token: string } }): Promise<{ ok: true; wires: ReviewedWire[]; warnings: string[] } | { ok: false; error: string }> {
  const warnings: string[] = [];
  const byDigest = new Map<string, ReviewedWire>();
  const audit = await auditGrantsThroughHarness({ person: input.person, session: input.session });
  if (!audit.ok) return { ok: false, error: `the reviewed list could not be read from your agent: ${audit.error}` };
  for (const g of audit.audit.grants as Array<GrantRow & { signed?: 'approved-digest' | 'key' }>) {
    if (g.revoked) continue;
    if (!g.signed) { warnings.push(`${g.holderName ?? g.holder} (${g.kind}): your agent did not say how this wire is signed — it will be re-approved, and if it was key-signed it will need re-issuing from its screen`); }
    byDigest.set(g.digest.toLowerCase(), { digest: g.digest as Hex, kind: g.kind, holder: g.holder, ...(g.holderName ? { holderName: g.holderName } : {}), what: g.what, signed: g.signed ?? 'approved-digest', source: g.source });
  }
  await ensureCsrfToken();
  const res = await fetch('/connect/app-grants', { headers: { authorization: `Bearer ${input.session.token}`, ...csrfHeaders() }, credentials: 'include' });
  const out = (await res.json().catch(() => ({}))) as { ok?: boolean; grants?: Array<{ clientId: string; appName?: string; template: string; delegate: string; delegation: DelegationWire; validUntil?: number | null }> };
  if (!res.ok || !out.ok) warnings.push('the apps you authorized with your own wire could not be listed — those wires will need re-authorizing at the app');
  for (const row of out.grants ?? []) {
    if (row.validUntil && row.validUntil < Date.now()) continue;
    const digest = digestOf(row.delegation);
    const k = digest.toLowerCase();
    const prior = byDigest.get(k);
    byDigest.set(k, { ...(prior ?? {}), digest, kind: 'app', holder: row.delegate.toLowerCase(), holderName: row.appName ?? row.clientId, what: `${row.template} — asks your agent as you`, signed: wireSigning(row.delegation), wire: row.delegation, clientId: row.clientId, source: 'app-grants' });
  }
  return { ok: true, wires: [...byDigest.values()], warnings };
}

export interface RotationOutcome {
  txHash?: Hex;
  reapproved: number;
  reissued: number;
  struck: number;
  newCredentialIdDigest: Hex;
  /** Things that landed on chain but whose bookkeeping failed — the person is told, never left guessing. */
  warnings: string[];
}

/**
 * Replace THIS DEVICE's passkey. `keep` names the digests the person kept from the reviewed list; every other live
 * wire is struck (revoked). `signHash` is the OLD credential's signer — the batch is its last act.
 */
export async function rotateThisDevicePasskey(input: {
  person: Address;
  session: { token: string };
  signHash: SignHash;
  wires: ReviewedWire[];
  keep: ReadonlySet<string>;
  label: string;
  onStep?: (s: string) => void;
}): Promise<{ ok: true; outcome: RotationOutcome } | { ok: false; error: string }> {
  const step = input.onStep ?? (() => {});
  const avail = rotationAvailability();
  if (!avail.ok) return { ok: false, error: avail.reason };
  const mode = await readCustodyMode(input.person);
  if (mode !== 0) return { ok: false, error: 'this home is custody-governed — its credentials rotate through the custody policy under your trustees\' quorum, not from this screen' };
  const old = loadPasskey();
  if (!old) return { ok: false, error: 'this device holds no passkey to replace' };

  const kept = input.wires.filter((w) => input.keep.has(w.digest.toLowerCase()));
  const struck = input.wires.filter((w) => !input.keep.has(w.digest.toLowerCase()));
  // Key-signed wires the Home holds are re-issued; key-signed wires only the agent holds cannot be re-issued from
  // here (the agent audits them, it does not hand out wires) — they are re-approved by digest, which does nothing
  // for a key-signed object, so the person is told to re-authorize those at their screen.
  const warnings: string[] = [];
  const reapprove: Hex[] = [];
  const lineages: DelegationLineageV1[] = [];
  const replacements: Array<{ clientId: string; wire: LineageWire }> = [];
  for (const w of kept) {
    if (w.signed === 'key') {
      if (w.wire && w.clientId) {
        const r = reissueForRotation(toLineageWire(w.wire), CHAIN_ID, CONTRACTS.delegationManager);
        reapprove.push(r.digest);
        lineages.push(r.lineage);
        replacements.push({ clientId: w.clientId, wire: r.wire });
      } else {
        warnings.push(`${w.holderName ?? w.holder} (${w.kind}) is a key-signed wire your agent holds — re-authorize it from its own screen after this rotation`);
      }
    } else {
      reapprove.push(w.digest);
    }
  }

  step('Creating the new passkey on this device…');
  let fresh: Awaited<ReturnType<typeof registerPasskeyCredentialRef>>;
  try { fresh = await registerPasskeyCredentialRef(input.label); }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'the new passkey could not be created' }; }

  const revoke = struck.filter((w) => w.wire).map((w) => w.wire!);
  step(`Confirm with your current passkey — one signature retires it, re-approves ${reapprove.length} wire${reapprove.length === 1 ? '' : 's'}${revoke.length ? ` and revokes ${revoke.length}` : ''}…`);
  const res = await rotateCredential(input.person, input.signHash, { add: fresh.ref, retire: { kind: 'passkey', credentialIdDigest: old.credentialIdDigest }, reapprove, revoke });
  if (!res.ok) {
    // The chain did not move: the OLD passkey is still the credential, so it must be the one this device holds.
    storePasskey(old);
    return { ok: false, error: res.error };
  }

  // Landed. Everything below is bookkeeping over a fact the chain already holds; a failure here is said, not hidden.
  step('Recording the re-issued wires…');
  await ensureCsrfToken();
  for (const l of lineages) {
    const r = await fetch(`/a2a/interactions/${input.person.toLowerCase()}/record.put`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...csrfHeaders() }, body: JSON.stringify({ session: input.session.token, recordType: lineageRecordType(l.hash), record: l }) });
    if (!r.ok) warnings.push(`the lineage record for ${l.hash.slice(0, 12)}… could not be written — the delegate will be asked to re-authorize instead of refreshing`);
  }
  for (const rep of replacements) {
    const r = await fetch('/connect/app-grants', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', authorization: `Bearer ${input.session.token}`, ...csrfHeaders() }, body: JSON.stringify({ clientId: rep.clientId, delegation: rep.wire }) });
    if (!r.ok) warnings.push(`the app-grant row for ${rep.clientId} could not be re-pointed at the re-issued wire`);
  }
  // Struck wires: the ones the Home held were revoked in the batch above; the ones only the agent holds are dead
  // under the new epoch (not re-approved; or their key retired) — the person is told which, so the agent's grants
  // screen can say so on chain too.
  for (const w of struck) {
    if (!w.wire) warnings.push(`${w.holderName ?? w.holder} (${w.kind}): struck — void under the new epoch; revoke it from your agent's grants screen so the chain says so too`);
  }
  for (const w of struck.filter((x) => x.clientId)) {
    const r = await fetch('/connect/app-grants', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', authorization: `Bearer ${input.session.token}`, ...csrfHeaders() }, body: JSON.stringify({ clientId: w.clientId, revoked: true }) }).catch(() => null);
    if (!r?.ok) warnings.push(`the app-grant row for ${w.clientId} was struck on chain but could not be forgotten here`);
  }
  step('Linking the new passkey to this home…');
  for (let i = 0; i < 4; i++) {
    const r = await fetch('/connect/passkey/link', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${input.session.token}` }, body: JSON.stringify({ credentialIdDigest: fresh.passkey.credentialIdDigest, agent: input.person }) }).catch(() => null);
    if (r && (r.ok || r.status !== 409)) break;
    await new Promise((res2) => setTimeout(res2, 2500));
  }
  return { ok: true, outcome: { ...(res.txHash ? { txHash: res.txHash } : {}), reapproved: reapprove.length - lineages.length, reissued: lineages.length, struck: struck.length, newCredentialIdDigest: fresh.passkey.credentialIdDigest, warnings } };
}

export type { DemoPasskey };
