'use client';
// spec 278 P5 — vault-key ceremony (connected custodian), ONE-CLICK.
//
// Authorize demo-mcp to wield your PER-PERSON vault KEK. You sign a `VaultKeyAuthorization`
// (person SA → demo-mcp, one non-subdelegable VAULT_KEY_USE caveat) with YOUR credential
// (passkey / wallet / Google KMS); we POST the signed authorization to demo-mcp's
// /custody/vault-key/bind (same-origin via the /mcp-bind proxy). On success your vault flips
// from fail-closed to live. There is no global key — until you sign this, demo-mcp cannot
// decrypt your data at all (VKB-D1).
//
// The person no longer hand-enters anything: on load we ask demo-mcp to advertise the server's
// delegate + authorized scope (`/custody/vault-key/server-info`); the click runs `activateVault`,
// which PROVES control of the owner (ERC-1271 over the freshness-bound provision challenge), provisions
// this person's KEK (idempotent → kmsKeyRef) and binds the signed authorization. The home holds no key
// material — it only signs. So the ceremony is a single click: review + sign.
//
// WHY THE PROOF IS SIGNED HERE AND NOT AT LOAD. This page once POSTed `{ owner }` alone at load and the
// vault answered `issued_at_required`: provisioning wields the KMS admin credential and creates a real
// per-owner key, so it is gated on an owner-control proof (NEW-C3), which only the ceremony's click can
// sign (a passkey needs the gesture). On faithnet every demo person had been provisioned by the onboarding
// path first, so the load-time call was idempotently answered and the defect stayed invisible; imbnet's
// first person hit it (2026-10-11). `activateVault` is the one path every other entrance already uses.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSession } from '../../../src/context/session';
import { activateVault, activateInteractionsIfNeeded, resolveVia, type Via } from '../../../src/home/onboarding';
import { SectionShell } from '../../../src/components/portal/SectionShell';

const MCP_BIND = '/mcp-bind';

interface ServerInfo {
  serverId?: string;
  serverKey: string;
  defaultResources: string[];
  classificationCeiling: string;
  ops: ('read' | 'write')[];
}

export default function VaultKeyPage() {
  const { agentAddress, agentName, session, profile } = useSession();
  const [prep, setPrep] = useState<'loading' | 'ready' | 'error'>('loading');
  const [prepError, setPrepError] = useState<string | null>(null);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Resolve the signing credential from the agent's ACTUAL custody credential, not the cookie `via`
  // (which defaults to passkey → a WebAuthn prompt that fails for a Google/social-custodied agent).
  const via = useMemo<Via>(() => resolveVia(profile?.credential, session?.via), [profile?.credential, session?.via]);

  // Auto-prepare: discover the server delegate/scope so the person can review what they are about to sign.
  // Provisioning happens on the click, under the owner-control proof (see the header comment).
  useEffect(() => {
    if (!agentAddress) return;
    let cancelled = false;
    setPrep('loading');
    setPrepError(null);
    (async () => {
      const infoRes = await fetch(`${MCP_BIND}/custody/vault-key/server-info`).then((r) => r.json());
      if (cancelled) return;
      if (!infoRes?.serverKey) {
        setPrepError(infoRes?.error_description ?? infoRes?.detail ?? 'the vault did not describe its delegate');
        setPrep('error');
        return;
      }
      setInfo({
        serverKey: infoRes.serverKey,
        defaultResources: infoRes.defaultResources ?? ['person-pii', 'org-sensitive', 'profile', 'vault:impact-profile'],
        classificationCeiling: infoRes.classificationCeiling ?? 'regulated.high',
        ops: infoRes.ops ?? ['read', 'write'],
      });
      setPrep('ready');
    })().catch((e) => {
      if (cancelled) return;
      setPrepError(e instanceof Error ? e.message : 'could not prepare your vault key');
      setPrep('error');
    });
    return () => { cancelled = true; };
  }, [agentAddress]);

  const canSubmit = !!agentAddress && prep === 'ready' && agreed && !!info && !busy;

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!agentAddress || !info) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      // Proof → provision → bind, one path (the same one onboarding, Ask and the social entrances use).
      const out = await activateVault(agentAddress, via, session?.token ? { token: session.token } : undefined);
      if (!out.ok) { setError(out.error); return; }
      // The owner's own records (profile, capability record) live on their InteractionsDO (record.get/put), which
      // needs the INTERACTIONS grant — a distinct plane from the vault key. Users onboarded before the
      // interactions plane (spec 322) existed have their vault key bound but `granted:false`, so every
      // record.get 409s ("no interactions grant") and the profile misreads it as "activate your vault
      // key". Enabling it here (idempotent; zero-prompt on KMS/wallet homes) unblocks them on this one
      // ceremony — the same plane securing sets up for new users. Best-effort: the vault key still bound.
      const ix = await activateInteractionsIfNeeded(agentAddress, via, session?.token ? { token: session.token } : undefined);
      if (!ix.ok) console.warn('[vault-key] interactions plane not enabled:', ix.error);
      setDone(out.kmsKeyRef);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'vault-key bind failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionShell title="Activate your private vault key">
      {!agentAddress ? (
        <p>Connect first — this authorizes a key for your agent.</p>
      ) : done ? (
        <div>
          <p>✅ Your vault is live. demo-mcp may now decrypt your data only under your own KEK,
            and only because you authorized it — revocable at any time.</p>
          <p className="muted small">Your profile and data are now sealed under your own key. Head to{' '}
            <a href="/profile">your profile</a> to fill it in.</p>
        </div>
      ) : prep === 'loading' ? (
        <p>Preparing your private vault key…</p>
      ) : prep === 'error' ? (
        <div>
          <p className="err">Could not prepare your vault key: {prepError}</p>
          <button onClick={() => location.reload()}>Try again</button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p>
            You are <strong>{agentName ?? agentAddress}</strong>. Signing below authorizes
            <strong> demo-mcp</strong> to wield your per-person vault key for{' '}
            <code>{info?.defaultResources.join(', ')}</code> (read + write, ceiling{' '}
            <code>{info?.classificationCeiling}</code>). Non-subdelegable. Until you do, your vault is fail-closed.
          </p>
          <p className="muted small">
            Your key is provisioned in your name when you sign. You don&apos;t need to enter anything — just review and sign.
          </p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            I authorize demo-mcp to use this key for my vault (signed with my {via} credential).
          </label>
          {error && <p className="err">{error}</p>}
          <button type="submit" disabled={!canSubmit}>
            {busy ? 'Signing + binding…' : 'Sign + activate vault'}
          </button>
        </form>
      )}
    </SectionShell>
  );
}
