'use client';
// /workspace-read — "Let <name>.svc read works it is granted": the person, as the CUSTODIAN of a service agent they
// chartered, signs that agent's A2A signing wire for `library.granted.read`. An app sends the member here the way it sends
// them to /choose-treasury and /reader-pass, and the same gate runs first:
//
//   /workspace-read?client_id=…&redirect_uri=…&state=…&agent=0x…&publisher=0x…
//
//   enabled   ?read_wire=enabled&read_wire_hash=0x…&agent=0x…&state=…
//   refused   ?read_wire_error=denied|not_custodian|not_service|failed&agent=0x…&state=…
//
// Contract and gate: src/lib/workspace-read-ceremony.ts. Ceremony: src/home/workspace-read-wire.ts (the org routing-enable's
// mint + custodian signature + DO verify/store, for a SERVICE and exactly one method). Outside the `(portal)` group for the
// reason /choose-treasury is: the portal gate would render the dashboard around one decision.
//
// The person decides here, with a click: nothing is signed on arrival. Declining is an answer (`denied`), not a failure.
// The same action lives on the agent's own Access page (/service/<agent>/access), where it can also be revoked.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { SessionProvider, useSession } from '../../src/context/session';
import { EntryExperience } from '../../src/components/onboarding/EntryExperience';
import { BrandShield } from '../../src/components/shared/BrandShield';
import { useManagedAgents } from '../../src/components/portal/ManagedAgents';
import { knownRelyingClient, primeRelyingClient } from '../../src/lib/relying-clients';
import type { OidcClient } from '../../src/lib/oidc-clients';
import { agentClassOf } from '../../src/lib/agent-class';
import { nameLabel } from '../../src/lib/domain';
import {
  parseWorkspaceReadRequest, workspaceReadRefusal, workspaceReadReturnUrl,
  type WorkspaceReadError, type WorkspaceReadRefusal, type WorkspaceReadRequest,
} from '../../src/lib/workspace-read-ceremony';
import { enableWorkspaceReadWire, workspaceReadDeps } from '../../src/home/workspace-read-wire';
import { whitelabel } from '../../src/whitelabel/config';

type Check = { k: 'checking' } | { k: 'ok'; req: WorkspaceReadRequest; client: OidcClient } | { k: 'refused'; refusal: WorkspaceReadRefusal };
type Run = { k: 'idle' } | { k: 'busy' } | { k: 'failed'; said: string; error: WorkspaceReadError };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="onboarding-screen">
      <div className="onboarding-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', alignSelf: 'flex-start' }}>
          <BrandShield size={28} />
          <strong style={{ fontWeight: 800, color: 'var(--color-text-primary)' }}>{whitelabel.brand.name}</strong>
        </div>
        {children}
      </div>
    </div>
  );
}

function Body() {
  const { phase, session, agentAddress, profile } = useSession();
  const { agents, loaded } = useManagedAgents(session?.token ?? null, 'any');
  const [check, setCheck] = useState<Check>({ k: 'checking' });
  const [run, setRun] = useState<Run>({ k: 'idle' });

  useEffect(() => {
    const req = parseWorkspaceReadRequest(window.location.href);
    if (!req) { setCheck({ k: 'refused', refusal: workspaceReadRefusal(null, null)! }); return; }
    let live = true;
    void primeRelyingClient(req.clientId).then(() => {
      if (!live) return;
      const client = knownRelyingClient(req.clientId);
      const refusal = workspaceReadRefusal(req, client);
      if (refusal) setCheck({ k: 'refused', refusal });
      else setCheck({ k: 'ok', req, client: client! });
    });
    return () => { live = false; };
  }, []);

  if (check.k === 'checking') return <Shell><p className="onboarding-busy-msg">Checking who sent you…</p></Shell>;
  if (check.k === 'refused') {
    // Names the check and goes nowhere — the redirect_uri is not verified, so there is nowhere safe to send them.
    return (
      <Shell>
        <h1 className="onboarding-h1">We didn&apos;t open this</h1>
        <p className="onboarding-sub">Nothing was signed. Go back to the app you started from and try again from there.</p>
        <p className="onboarding-hint" data-testid="refusal-detail">Refused at: <strong>{check.refusal.check}</strong> — {check.refusal.detail}</p>
      </Shell>
    );
  }
  if (phase === 'restoring') return <Shell><p className="onboarding-busy-msg">Opening your home…</p></Shell>;
  if (phase !== 'authed' || !session?.token || !agentAddress) return <EntryExperience mode="entry" />;
  if (!loaded) return <Shell><p className="onboarding-busy-msg">Finding the agent…</p></Shell>;

  const { req, client } = check;
  const row = agents.find((a) => a.agent.toLowerCase() === req.agent);
  const isService = !!row && agentClassOf(row.kind) === 'service';
  const label = row?.name ? nameLabel(row.name) : `${req.agent.slice(0, 8)}…${req.agent.slice(-4)}`;
  const leave = (r: { hash: string } | { error: WorkspaceReadError }) => { window.location.href = workspaceReadReturnUrl(req.redirectUri, req.state, req.agent, r); };

  const go = async () => {
    setRun({ k: 'busy' });
    const deps = await workspaceReadDeps({ token: session.token, via: session.via, credential: (profile as { credential?: string } | null)?.credential, person: agentAddress as Address });
    const r = await enableWorkspaceReadWire(deps, { agent: req.agent as Address, agentLabel: label, isService, publisher: req.publisher as Address });
    if (r.ok) leave({ hash: r.hash });
    else setRun({ k: 'failed', said: r.said, error: r.error });
  };

  return (
    <Shell>
      <h1 className="onboarding-h1">Let {label} read works it is granted</h1>
      <p className="onboarding-sub">
        {client.name ?? req.clientId} is asking. A publisher can grant {label} a read of a restricted work; to fetch it,
        {' '}{label} signs its request as itself. This signs one scoped, revocable authorization with your credential, as
        {' '}{label}&rsquo;s custodian: its runtime may sign <code>library.granted.read</code> — and nothing else — at that one publisher&rsquo;s agent ({req.publisher.slice(0, 8)}…{req.publisher.slice(-4)}), for 180 days.
        You can revoke it any time from {label}&rsquo;s Access page.
      </p>
      {run.k === 'failed' && <p role="alert" style={{ color: 'var(--color-danger, #b3261e)', wordBreak: 'break-word' }}>{run.said}</p>}
      <div style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap' }}>
        {run.k !== 'failed' && (
          <button type="button" className="btn btn-primary" disabled={run.k === 'busy'} onClick={() => void go()} data-testid="workspace-read-sign">
            {run.k === 'busy' ? 'Signing…' : `Let ${label} read`}
          </button>
        )}
        <button type="button" className="btn" disabled={run.k === 'busy'} onClick={() => leave({ error: run.k === 'failed' ? run.error : 'denied' })}>
          {run.k === 'failed' ? 'Back to the app' : 'Not now'}
        </button>
      </div>
    </Shell>
  );
}

export default function WorkspaceReadPage() {
  return (
    <SessionProvider>
      <Body />
    </SessionProvider>
  );
}
