'use client';

import { useMemo, useState } from 'react';
import { hashDelegation, type VaultRecordScopeGrant } from '@agenticprimitives/delegation';
import type { Address, Hex } from '@agenticprimitives/types';

import { useSession } from '../../../src/context/session';
import { resolveVia, signHashFor } from '../../../src/home/onboarding';
import {
  issueVaultRecordScopeDelegation,
  toWire,
  type DelegationWire,
} from '../../../src/lib/delegation';
import { revokeGrantedDelegation } from '../../../src/connect-client';
import { CHAIN_ID, CONTRACTS } from '../../../src/lib/chain';

type Action = 'issue' | 'revoke';

interface RoleRequest {
  action: Action;
  org: Address;
  orgLabel?: string;
  subject: Address;
  subjectLabel?: string;
  role: string;
  scope: string;
  scopeRef: string | null;
  scopeLabel?: string;
  folder: string;
  name: string;
  record: Record<string, unknown>;
  grants?: VaultRecordScopeGrant[];
  returnUrl?: string;
  wireDigest?: Hex;
}

const WIRE_FOLDER = 'vault-authority/wires';

export default function VaultSubjectRolePage() {
  const { phase, session, profile } = useSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const req = useMemo(() => parseRoleRequest(), []);

  async function run() {
    if (!session || !req) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const via = resolveVia(profile?.credential, session.via);
      const signHash = await signHashFor(via, req.org, { token: session.token });
      if (req.action === 'issue') {
        if (!req.grants?.length) throw new Error('role request has no vault grants');
        const delegation = await issueVaultRecordScopeDelegation(req.org, req.subject, req.grants, signHash);
        const wire = toWire(delegation);
        const digest = hashDelegation(delegation, CHAIN_ID, CONTRACTS.delegationManager);
        const record = {
          ...req.record,
          status: 'active',
          materializedBy: [...asStrings(req.record['materializedBy']), digest],
        };
        await saveArtifacts(session.token, req, record, wire, digest);
        setMessage(complete(req, `Issued ${req.role} for ${labelOf(req)}.`));
        return;
      }

      const digest = req.wireDigest ?? asStrings(req.record['materializedBy'])[0];
      if (!digest) throw new Error('role record has no wire digest to revoke');
      const wire = await loadWire(session.token, req.org, digest);
      if (!wire) throw new Error('the full wire is not stored in this org vault; reissue this role before revoking it here');
      const revoked = await revokeGrantedDelegation(wire, signHash);
      if (!revoked.ok) throw new Error(revoked.error);
      const record = { ...req.record, status: 'revoked', revokedAt: new Date().toISOString() };
      await saveRoleRecord(session.token, req, record);
      setMessage(complete(req, `Revoked ${req.role} for ${labelOf(req)}.`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'restoring') return <main className="dash"><p>Restoring Home session...</p></main>;
  if (!req) return <main className="dash"><h1>Role ceremony</h1><p>Missing or invalid role request.</p></main>;
  if (!session) return <main className="dash"><h1>Role ceremony</h1><p>Sign in to Home as an org steward to continue.</p></main>;

  return (
    <main className="dash" style={{ maxWidth: 760 }}>
      <h1>{req.action === 'issue' ? 'Issue role' : 'Revoke role'}</h1>
      <section className="dash-section">
        <p style={{ marginTop: 0 }}>
          <b>{req.orgLabel ?? req.org}</b> will {req.action} <b>{req.role}</b> for{' '}
          <b>{req.subjectLabel ?? req.subject}</b>.
        </p>
        <dl style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '.35rem .75rem', fontSize: '.9rem' }}>
          <dt>Scope</dt><dd>{req.scopeLabel ?? req.scopeRef ?? req.scope}</dd>
          <dt>Subject</dt><dd><code>{req.subject}</code></dd>
          <dt>Record</dt><dd><code>{req.folder}/{req.name}</code></dd>
        </dl>
        {req.action === 'issue' && (
          <p style={{ fontSize: '.86rem', opacity: 0.72 }}>
            Home will sign the delegation wire and store both the role assignment and the private wire copy in the org vault.
          </p>
        )}
        {req.action === 'revoke' && (
          <p style={{ fontSize: '.86rem', opacity: 0.72 }}>
            Home will revoke the stored wire on-chain, then mark the role assignment revoked.
          </p>
        )}
        <button className="btn" disabled={busy} onClick={() => void run()}>
          {busy ? 'Working...' : req.action === 'issue' ? 'Sign and issue role' : 'Sign and revoke role'}
        </button>
        {message && <p style={{ color: '#047857', marginTop: '.75rem' }}>{message}</p>}
        {error && <p style={{ color: '#b91c1c', marginTop: '.75rem' }}>{error}</p>}
      </section>
    </main>
  );
}

function parseRoleRequest(): RoleRequest | null {
  try {
    const p = new URLSearchParams(window.location.search);
    const action = p.get('action') === 'revoke' ? 'revoke' : 'issue';
    const org = p.get('org') as Address | null;
    const subject = p.get('subject') as Address | null;
    const folder = p.get('folder') ?? '';
    const name = p.get('name') ?? '';
    const record = decodeJson<Record<string, unknown>>(p.get('record'));
    if (!isAddress(org) || !isAddress(subject) || !folder || !name || !record) return null;
    return {
      action,
      org,
      subject,
      folder,
      name,
      record,
      role: p.get('role') ?? String(record['role'] ?? 'role'),
      scope: p.get('scope') ?? String(record['scope'] ?? 'resource'),
      scopeRef: p.get('scopeRef') || null,
      orgLabel: p.get('orgLabel') ?? undefined,
      subjectLabel: p.get('subjectLabel') ?? undefined,
      scopeLabel: p.get('scopeLabel') ?? undefined,
      returnUrl: p.get('returnUrl') ?? undefined,
      wireDigest: (p.get('wireDigest') as Hex | null) ?? undefined,
      grants: decodeJson<VaultRecordScopeGrant[]>(p.get('grants')) ?? undefined,
    };
  } catch {
    return null;
  }
}

async function saveArtifacts(
  token: string,
  req: RoleRequest,
  record: Record<string, unknown>,
  wire: DelegationWire,
  digest: Hex,
) {
  await saveBatch(token, req.org, [
    roleArtifact(req, record),
    {
      folder: WIRE_FOLDER,
      name: `${digest}.json`,
      kind: 'json-ld',
      bytesB64: b64(JSON.stringify({ kind: 'vault-subject-role-wire', digest, wire, createdAt: new Date().toISOString() }, null, 2)),
    },
  ]);
}

async function saveRoleRecord(token: string, req: RoleRequest, record: Record<string, unknown>) {
  await saveBatch(token, req.org, [roleArtifact(req, record)]);
}

function roleArtifact(req: RoleRequest, record: Record<string, unknown>) {
  return { folder: req.folder, name: req.name, kind: 'json-ld', bytesB64: b64(JSON.stringify(record, null, 2)) };
}

async function saveBatch(token: string, org: Address, artifacts: unknown[]) {
  const res = await fetch('/connect/library', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ org, action: 'save-batch', artifacts }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `vault write failed (${res.status})`);
}

async function loadWire(token: string, org: Address, digest: string): Promise<DelegationWire | null> {
  const res = await fetch(`/connect/library?org=${encodeURIComponent(org)}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`could not read org vault (${res.status})`);
  const body = (await res.json().catch(() => ({}))) as { artifacts?: Array<{ folder?: string; name?: string; bytesB64?: string }> };
  const artifact = (body.artifacts ?? []).find((a) => a.folder === WIRE_FOLDER && a.name === `${digest}.json`);
  if (!artifact?.bytesB64) return null;
  const parsed = JSON.parse(atob(artifact.bytesB64)) as { wire?: DelegationWire };
  return parsed.wire ?? null;
}

function complete(req: RoleRequest, msg: string) {
  setTimeout(() => {
    if (req.returnUrl) {
      const url = new URL(req.returnUrl);
      url.searchParams.set('role_status', 'ok');
      window.location.href = url.toString();
    }
  }, 900);
  return msg;
}

function decodeJson<T>(value: string | null): T | null {
  if (!value) return null;
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0)))) as T;
}

function b64(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function isAddress(value: string | null): value is Address {
  return !!value && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function labelOf(req: RoleRequest): string {
  return req.subjectLabel ?? `${req.subject.slice(0, 6)}...${req.subject.slice(-4)}`;
}
