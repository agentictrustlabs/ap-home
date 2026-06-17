'use client';
// spec 278 P5 — vault-key ceremony (connected custodian).
//
// Authorize demo-mcp to wield your PER-PERSON vault KEK. You sign a `VaultKeyAuthorization`
// (person SA → demo-mcp, one non-subdelegable VAULT_KEY_USE caveat) with YOUR credential
// (passkey / wallet / Google KMS); we POST the signed authorization to demo-mcp's
// /custody/vault-key/bind (same-origin via the /mcp-bind proxy). On success your vault flips
// from fail-closed to live. There is no global key — until you sign this, demo-mcp cannot
// decrypt your data at all (VKB-D1).
//
// The KEK (`kmsKeyRef`) is provisioned out-of-band by the operator (spec 276 ap-provision-gcp)
// and supplied here; the home holds no key material — it only signs the grant.

import { useMemo, useState, type FormEvent } from 'react';
import { useSession } from '../../../src/context/session';
import { bindVaultKey, type Via } from '../../../src/home/onboarding';
import { SectionShell } from '../../../src/components/portal/SectionShell';

const DEFAULT_RESOURCES = ['person-pii', 'org-sensitive', 'profile', 'vault:impact-profile'];
const DEFAULT_CEILING = 'regulated.high';

export default function VaultKeyPage() {
  const { agentAddress, agentName, session } = useSession();
  const [kmsKeyRef, setKmsKeyRef] = useState('');
  const [serverKey, setServerKey] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const via = useMemo<Via>(() => {
    const v = (session?.via ?? 'passkey').toLowerCase();
    return v === 'wallet' ? 'wallet' : v === 'google' ? 'google' : 'passkey';
  }, [session?.via]);

  const canSubmit = !!agentAddress && agreed && /^0x[0-9a-fA-F]{40}$/.test(serverKey) && kmsKeyRef.trim().length > 0 && !busy;

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!agentAddress) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const out = await bindVaultKey(
        agentAddress,
        {
          vaultId: 'demo-mcp',
          kmsKeyRef: kmsKeyRef.trim(),
          serverKey: serverKey.trim() as `0x${string}`,
          allowedResources: DEFAULT_RESOURCES,
          classificationCeiling: DEFAULT_CEILING,
          ops: ['read', 'write'],
        },
        via,
        session?.token ? { token: session.token } : undefined,
      );
      if (!out.ok) {
        setError(out.error);
        return;
      }
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
          <p className="muted small">KEK: <code>{done}</code></p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p>
            You are <strong>{agentName ?? agentAddress}</strong>. Signing below authorizes
            <strong> demo-mcp</strong> to wield your per-person vault key for{' '}
            <code>{DEFAULT_RESOURCES.join(', ')}</code> (read + write, ceiling{' '}
            <code>{DEFAULT_CEILING}</code>). Non-subdelegable. Until you do, your vault is fail-closed.
          </p>
          <label>
            KEK resource name (from the operator&apos;s provisioning)
            <input value={kmsKeyRef} onChange={(e) => setKmsKeyRef(e.target.value)}
              placeholder="projects/…/cryptoKeys/person-…" style={{ width: '100%' }} />
          </label>
          <label>
            demo-mcp delegate key
            <input value={serverKey} onChange={(e) => setServerKey(e.target.value)}
              placeholder="0x…" style={{ width: '100%' }} />
          </label>
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
