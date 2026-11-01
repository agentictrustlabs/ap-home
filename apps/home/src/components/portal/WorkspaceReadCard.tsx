'use client';
// "Let <name>.svc read works it is granted" — the service agent's library-read signing wire, on the agent's Access page.
// Turning it on runs the ceremony in src/home/workspace-read-wire.ts (custody check → the custodian signs → the agent's
// InteractionsDO verifies and keeps it). Turning it off REVOKES it on chain, then clears the stored copy.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { BusyButton } from '../shared/BusyButton';
import { enableWorkspaceReadWire, readWorkspaceReadStatus, revokeWorkspaceReadWire, workspaceReadDeps, type WorkspaceReadStatus } from '../../home/workspace-read-wire';
import { nameLabel } from '../../lib/domain';

const day = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toLocaleDateString() : null);

export function WorkspaceReadCard({ agent, name, isService }: { agent: string; name: string; isService: boolean }) {
  const { session, agentAddress, profile } = useSession();
  const [status, setStatus] = useState<WorkspaceReadStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = name ? nameLabel(name) : `${agent.slice(0, 8)}…`;

  const deps = useCallback(async () => workspaceReadDeps({
    token: session!.token, via: session!.via, credential: (profile as { credential?: string } | null)?.credential, person: agentAddress as Address,
  }), [session, profile, agentAddress]);

  const load = useCallback(async () => {
    if (!session) return;
    try { setStatus(await readWorkspaceReadStatus(await deps(), agent as Address)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [session, deps, agent]);
  useEffect(() => { void load(); }, [load]);

  const enable = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const r = await enableWorkspaceReadWire(await deps(), { agent: agent as Address, agentLabel: label, isService });
      if (!r.ok) setError(r.said);
      await load();
    } finally { setBusy(false); }
  }, [deps, agent, label, isService, load]);

  const revoke = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const r = await revokeWorkspaceReadWire(await deps(), agent as Address);
      if (!r.ok) setError(r.error);
      await load();
    } finally { setBusy(false); }
  }, [deps, agent, load]);

  if (!session || !isService) return null;
  return (
    <div className="manage-card" data-testid="workspace-read-card">
      <div className="manage-card-head">
        <span className="manage-card-label">Read works it is granted</span>
        <span className={`manage-card-badge${status?.wirePresent ? ' live' : ''}`}>{status === null ? '…' : status.wirePresent ? 'on' : 'off'}</span>
      </div>
      <p className="manage-card-blurb">
        A publisher can grant {label} a read of a restricted work. To fetch it, {label} has to sign its request as itself —
        and it holds no key of its own. This signs a scoped, revocable authorization, once, with your credential as its
        custodian: it lets {label}&rsquo;s runtime sign <code>library.granted.read</code> and nothing else.
      </p>
      {status?.wirePresent ? (
        <>
          <p className="manage-card-blurb">
            On since {status.enabledAt ? new Date(status.enabledAt).toLocaleDateString() : '—'}
            {day(status.validUntil) ? `, until ${day(status.validUntil)}` : ''}. Stopping revokes it on chain — every
            publisher refuses a request under it from then on.
          </p>
          <BusyButton busy={busy} busyLabel="Revoking…" className="btn" onClick={() => void revoke()} data-testid="workspace-read-revoke">Stop — revoke it</BusyButton>
        </>
      ) : (
        <BusyButton busy={busy} busyLabel="Signing…" className="btn btn-primary" disabled={status === null || !status.sessionKey} onClick={() => void enable()} data-testid="workspace-read-enable">
          Let {label} read works it is granted
        </BusyButton>
      )}
      {status && !status.sessionKey && <p className="manage-card-blurb">This deployment has no interactions-session key, so no agent can sign here yet.</p>}
      {error && <p role="alert" style={{ color: 'var(--color-danger, #b3261e)', fontSize: '.82rem', wordBreak: 'break-word' }}>{error}</p>}
    </div>
  );
}
