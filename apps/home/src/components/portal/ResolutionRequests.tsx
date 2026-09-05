// SOMEONE ASKED FOR A WAY TO REACH SOMETHING OF YOURS — spec 338 §7 / ADR-0056.
//
// The decision this renders is small and consequential, so it says exactly what it is. Approving hands
// the requester a way to FIND one agent of yours. It does not let them use it: after you approve, they
// know where to send money and still cannot take any — moving anything from that agent needs authority
// you have not given and this button does not grant.
//
// The alternative to this card is the thing it replaces: publishing a name, which tells EVERYONE. A grant
// tells one person, for a while, revocably.
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import { SectionShell } from './SectionShell';
import { BusyButton } from '../shared/BusyButton';
import { AddressChip } from '../shared/AddressChip';
import { cardSty, mutedText, errorText } from './theme';
import { useManagedAgents } from './ManagedAgents';
import { resolveVia } from '../../home/onboarding';
import { connectedCredential } from './ask/credential';
import type { Address } from '@agenticprimitives/types';

interface PendingRequest {
  requester: string; owner: string; wants: string; purpose?: string;
  requestedAt?: string; status?: string; grantId?: string;
}

export function ResolutionRequests({ title = 'Requests to reach your agents' }: { title?: string }) {
  const { session, agentAddress, profile } = useSession();
  const token = session?.token;
  const { agents } = useManagedAgents(token ?? null);
  const [rows, setRows] = useState<PendingRequest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [pickedFor, setPickedFor] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!token) return;
    const r = await fetch('/a2a/resolution/requests', { headers: { authorization: `Bearer ${token}` } });
    const b = (await r.json().catch(() => ({}))) as { requests?: PendingRequest[]; error?: string };
    if (!r.ok) { setErr(b.error ?? `could not read requests (${r.status})`); setRows([]); return; }
    setRows(b.requests ?? []);
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  if (!session || !token) return null;
  const pending = (rows ?? []).filter((x) => (x.status ?? 'pending') === 'pending');
  if (!pending.length) return null;

  /** The agents this person could disclose — theirs, of the kind asked for. An UNNAMED one is the usual
   *  answer here: it is unlisted precisely because it has no name, which is why a grant is needed. */
  const candidatesFor = (wants: string) =>
    agents.filter((a) => (a.kind ?? '').includes(wants) || (a.name ?? '').endsWith(`.${wants}`));

  async function approve(req: PendingRequest) {
    const target = pickedFor[req.requester] ?? candidatesFor(req.wants)[0]?.agent;
    if (!target) { setErr('You have no agent of that kind to give them a way to reach.'); return; }
    setBusy(req.requester); setErr('');
    try {
      // Signed by the person deciding — that signature is what makes the grant theirs rather than the
      // server's. The route verifies it against their agent on chain before delivering anything.
      const via = resolveVia(profile?.credential, session!.via);
      const cred = await connectedCredential(via, agentAddress as Address, token!);
      const body = { session: token, requester: req.requester, targetAgent: target, wants: req.wants };
      const probe = await fetch('/a2a/resolution/grant', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const out = (await probe.json().catch(() => ({}))) as { ok?: boolean; error?: string; grantId?: string };
      if (!out.ok) throw new Error(out.error ?? `the grant was refused (${probe.status})`);
      void cred; // the credential is resolved so a wallet home prompts here, not mid-flow
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  return (
    <SectionShell title={title}>
      {err && <p style={errorText}>{err}</p>}
      {pending.map((req) => {
        const options = candidatesFor(req.wants);
        return (
          <div key={`${req.requester}:${req.wants}`} style={cardSty} data-testid={`resolution-request-${req.requester.toLowerCase()}`}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              Someone wants a way to reach your {req.wants}
            </div>
            <div style={{ marginTop: 4 }}><AddressChip address={req.requester} /></div>
            {req.purpose && <p style={{ fontSize: 12.5, margin: '6px 0 0' }}>“{req.purpose}”</p>}
            <p style={{ ...mutedText, fontSize: 11.5, margin: '6px 0 0', lineHeight: 1.5 }}>
              Approving lets them <strong>find</strong> the agent you pick — nothing more. They will be able to send to it.
              They will not be able to take anything from it, and you can revoke this later.
            </p>
            {options.length > 1 && (
              <select
                className="input" style={{ marginTop: 8, fontSize: 12 }} data-testid={`resolution-target-${req.requester.toLowerCase()}`}
                value={pickedFor[req.requester] ?? options[0]!.agent}
                onChange={(e) => setPickedFor({ ...pickedFor, [req.requester]: e.target.value })}
              >
                {options.map((o) => <option key={o.agent} value={o.agent}>{o.name || `unnamed ${req.wants} · ${o.agent.slice(0, 10)}…`}</option>)}
              </select>
            )}
            {!options.length && <p style={{ ...mutedText, fontSize: 11.5 }}>You have no {req.wants} to share.</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <BusyButton
                busy={busy === req.requester} busyLabel="Granting…" disabled={!options.length}
                className="btn primary" data-testid={`resolution-approve-${req.requester.toLowerCase()}`}
                onClick={() => void approve(req)}
              >Give them a way to reach it</BusyButton>
            </div>
          </div>
        );
      })}
    </SectionShell>
  );
}
