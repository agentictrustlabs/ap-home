// THE SECURITY SECTION'S CEREMONIES — spec 422 §3.2 / §3.3 and the owner's rule (2026-10-01): the Ask performs every
// feature a button performs. ONE implementation per act, called by the Sign-in page's buttons AND by the Ask when her
// agent's run asks for the ceremony (`InputRequired` confirmation with `summary.ceremony`, the spec-421 org-join shape):
//
//   credential-add    a passkey or wallet that signs for her, authorized by a credential that already does
//   credential-label  a label in her vault (the chain only knows the key)
//   channel-unlink    the server tombstones the facet; her vault records the unlink
//   channel-link      the code she verifies (the Email/Phone card IS the ceremony); `recordLinkedChannel` lands it
//
// Every runner needs her SESSION (and for a credential add, a credential that signs); none takes a mandate — these are
// self-acting, hers alone. The runtime's invoker reads her records afterwards and says what happened; nothing here
// tells the agent it succeeded.
import type { Address, Hex } from '@agenticprimitives/types';
import { canPerformSecurityAct } from '@agenticprimitives/connect';
import type { BasicProfile } from '../connect-client';
import { addPasskeyCredential, addWalletCredential } from '../connect-client';
import { resolveVia, signHashFor } from './onboarding';
import { emitControlEvent } from './control-plane';
import { sessionGrade } from '../lib/security-grade';
import { writeCredentialLabel, recordChannel, forgetChannel, type CredentialRef } from './credentials';

export interface CeremonyCtx {
  person: Address;
  session: { token: string; via: string };
  profile: BasicProfile | null;
  onStep?: (s: string) => void;
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// Index the passkey → home mapping so passkey sign-in resolves THIS home (a KMS/social home's SA is not derived from
// the passkey). Best-effort with a short retry: the add userOp just mined, but the link route re-reads `hasPasskey`
// on-chain and 409s until the RPC sees it.
export async function linkPasskeyToHome(agent: Address, credentialIdDigest: Hex, token: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch('/connect/passkey/link', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ credentialIdDigest, agent }) });
      if (r.ok || r.status !== 409) return;
    } catch { /* network hiccup — retry */ }
    await new Promise((res) => setTimeout(res, 2500));
  }
}

/** The signer for a custody act: the home's ACTUAL on-chain credential (a wallet home → MetaMask; a KMS/Google/email home →
 *  server-side, no prompt), never the raw session `via`. */
function currentAuthorizer(ctx: CeremonyCtx) {
  return signHashFor(resolveVia(ctx.profile?.credential, ctx.session.via), ctx.person, { token: ctx.session.token });
}

function requireGrade(ctx: CeremonyCtx, act: 'credential.add'): void {
  const r = canPerformSecurityAct(sessionGrade(ctx.profile), act);
  if (!r.ok) throw new Error(r.reason);
}

/** ADD a passkey (this device) or a wallet. */
export async function addCredentialCeremony(ctx: CeremonyCtx, input: { kind: 'passkey' | 'wallet'; label?: string }): Promise<{ ok: true; ref: CredentialRef; label: string; said: string } | { ok: false; error: string }> {
  requireGrade(ctx, 'credential.add');
  const step = ctx.onStep ?? (() => {});
  const label = (input.label ?? '').trim() || (input.kind === 'passkey' ? 'Passkey' : 'Wallet');
  step('Starting…');
  const authorizer = await currentAuthorizer(ctx);
  if (input.kind === 'wallet') {
    const r = await addWalletCredential(ctx.person, authorizer, step);
    if (!r.ok) return { ok: false, error: r.error };
    const ref: CredentialRef = { kind: 'custodian', address: r.added };
    await writeCredentialLabel(ctx.person, { ref, label, createdAt: new Date().toISOString() }).catch(() => {});
    void emitControlEvent(ctx.session.token, 'credential-added');
    return { ok: true, ref, label, said: `Wallet ${shortAddr(r.added)} now signs for you` };
  }
  const r = await addPasskeyCredential(ctx.person, authorizer, step);
  if (!r.ok) return { ok: false, error: r.error };
  step('Linking the passkey to your home…');
  await linkPasskeyToHome(ctx.person, r.credentialIdDigest, ctx.session.token);
  const ref: CredentialRef = { kind: 'passkey', credentialIdDigest: r.credentialIdDigest };
  await writeCredentialLabel(ctx.person, { ref, label, device: 'This device', createdAt: new Date().toISOString() }).catch(() => {});
  void emitControlEvent(ctx.session.token, 'credential-added');
  return { ok: true, ref, label, said: 'Passkey added — it signs for you from this device' };
}

/** RENAME — a label in her vault. */
export async function labelCredentialCeremony(ctx: Pick<CeremonyCtx, 'person'>, input: { ref: CredentialRef; label: string; createdAt?: string }): Promise<void> {
  await writeCredentialLabel(ctx.person, { ref: input.ref, label: input.label.trim(), createdAt: input.createdAt ?? new Date().toISOString() });
}

/** After the code was verified and the server LINKED the facet (the card's `onLinked`): her vault records the channel. */
export async function recordLinkedChannel(ctx: CeremonyCtx, input: { kind: 'email' | 'phone'; value: string }): Promise<void> {
  await recordChannel(ctx.person, input).catch(() => {});
  void emitControlEvent(ctx.session.token, 'channel-linked');
}

/** UNLINK — the server tombstones the facet; her vault records the unlink. */
export async function unlinkChannelCeremony(ctx: CeremonyCtx, input: { kind: 'email' | 'phone'; value: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await fetch(`/connect/${input.kind}/unlink`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.session.token}` }, body: JSON.stringify({ value: input.value }) });
  const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!r.ok || !d.ok) return { ok: false, error: d.error ?? 'unlink failed' };
  await forgetChannel(ctx.person, input).catch(() => {});
  void emitControlEvent(ctx.session.token, 'channel-unlinked');
  return { ok: true };
}

/** The ceremonies an Ask confirmation can name (the runtime's `summary.ceremony`). */
export type SecurityCeremonySummary =
  | { ceremony: 'credential-add'; kind: 'passkey' | 'wallet'; label?: string }
  | { ceremony: 'credential-label'; ref: CredentialRef; from?: string; label: string }
  | { ceremony: 'channel-link'; kind: 'email' | 'phone'; value?: string }
  | { ceremony: 'channel-unlink'; kind: 'email' | 'phone'; value: string };

export const isSecurityCeremony = (s: unknown): s is SecurityCeremonySummary =>
  !!s && typeof s === 'object' && ['credential-add', 'credential-label', 'channel-link', 'channel-unlink'].includes(String((s as { ceremony?: unknown }).ceremony));

/** The button's words for a ceremony prompt. */
export function ceremonyButtonLabel(s: SecurityCeremonySummary): string {
  switch (s.ceremony) {
    case 'credential-add': return s.kind === 'wallet' ? 'Connect wallet & add' : 'Create passkey & add';
    case 'credential-label': return `Rename to "${s.label}"`;
    case 'channel-link': return s.kind === 'email' ? 'Verify email' : 'Verify phone';
    case 'channel-unlink': return 'Unlink';
  }
}

/** RUN the ceremony the Ask's confirmation named, with the same code the button runs. `channel-link` is run by the
 *  card the prompt renders (the code she types), so here it is a no-op. Throws with the reason when it cannot run. */
export async function runSecurityCeremony(ctx: CeremonyCtx, s: SecurityCeremonySummary): Promise<void> {
  switch (s.ceremony) {
    case 'credential-add': {
      const r = await addCredentialCeremony(ctx, { kind: s.kind, ...(s.label ? { label: s.label } : {}) });
      if (!r.ok) throw new Error(r.error);
      return;
    }
    case 'credential-label':
      await labelCredentialCeremony(ctx, { ref: s.ref, label: s.label });
      return;
    case 'channel-unlink': {
      const r = await unlinkChannelCeremony(ctx, { kind: s.kind, value: s.value });
      if (!r.ok) throw new Error(r.error);
      return;
    }
    case 'channel-link':
      return;
  }
}
