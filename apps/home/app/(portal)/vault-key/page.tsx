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
// The person no longer hand-enters anything: on load we ask demo-mcp to provision (idempotent)
// this person's KEK (`/custody/vault-key/provision` → kmsKeyRef) and to advertise the server's
// delegate + authorized scope (`/custody/vault-key/server-info`). The home holds no key material —
// it only signs the grant. So the ceremony is a single click: review + sign.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSession } from '../../../src/context/session';
import { bindVaultKey, resolveVia, type Via } from '../../../src/home/onboarding';
import { SectionShell } from '../../../src/components/portal/SectionShell';

const MCP_BIND = '/mcp-bind';

interface ServerInfo {
  serverKey: string;
  defaultResources: string[];
  classificationCeiling: string;
  ops: ('read' | 'write')[];
}

export default function VaultKeyPage() {
  const { agentAddress, agentName, session, profile } = useSession();
  const [prep, setPrep] = useState<'loading' | 'ready' | 'error'>('loading');
  const [prepError, setPrepError] = useState<string | null>(null);
  const [kmsKeyRef, setKmsKeyRef] = useState('');
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Resolve the signing credential from the agent's ACTUAL custody credential, not the cookie `via`
  // (which defaults to passkey → a WebAuthn prompt that fails for a Google/social-custodied agent).
  const via = useMemo<Via>(() => resolveVia(profile?.credential, session?.via), [profile?.credential, session?.via]);

  // Auto-prepare: provision the KEK (idempotent) + discover the server delegate/scope.
  useEffect(() => {
    if (!agentAddress) return;
    let cancelled = false;
    setPrep('loading');
    setPrepError(null);
    (async () => {
      const infoRes = await fetch(`${MCP_BIND}/custody/vault-key/server-info`).then((r) => r.json());
      const provRes = await fetch(`${MCP_BIND}/custody/vault-key/provision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: agentAddress }),
      }).then((r) => r.json());
      if (cancelled) return;
      if (!provRes?.ok || !provRes.kmsKeyRef) {
        setPrepError(provRes?.error_description ?? provRes?.detail ?? 'could not provision your vault key');
        setPrep('error');
        return;
      }
      setKmsKeyRef(provRes.kmsKeyRef);
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
      const out = await bindVaultKey(
        agentAddress,
        {
          vaultId: 'demo-mcp',
          kmsKeyRef: kmsKeyRef.trim(),
          serverKey: info.serverKey as `0x${string}`,
          allowedResources: info.defaultResources,
          classificationCeiling: info.classificationCeiling,
          ops: info.ops,
        },
        via,
        session?.token ? { token: session.token } : undefined,
      );
      if (!out.ok) { setError(out.error); return; }
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
            Your key has been provisioned in your name. You don&apos;t need to enter anything — just review and sign.
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
