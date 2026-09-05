// SOMEONE ASKED FOR A WAY TO REACH SOMETHING OF YOURS — spec 338 §7 / ADR-0056.
//
// The decision this renders is small and consequential, so it says exactly what it is. Approving hands
// the requester a way to FIND one agent of yours. It does not let them use it: after you approve, they
// know where to send money and still cannot take any — moving anything from that agent needs authority
// you have not given and this button does not grant.
//
// The alternative to this card is the thing it replaces: publishing a name, which tells EVERYONE. A grant
// tells one person, for a while, revocably.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../../context/session';
import { SectionShell } from './SectionShell';
import { BusyButton } from '../shared/BusyButton';
import { AddressChip } from '../shared/AddressChip';
import { cardSty, mutedText, errorText } from './theme';
import { useManagedAgents } from './ManagedAgents';
import { activateInteractionsIfNeeded, resolveVia } from '../../home/onboarding';
import { ensureCsrfToken, csrfHeaders } from '../../csrf';
import { connectedCredential } from './ask/credential';
import type { Address } from '@agenticprimitives/types';

interface PendingRequest {
  /** Absent on a `sent` row — this component renders only the requests addressed TO you. */
  requester?: string;
  kind?: string; owner?: string; wants?: string; purpose?: string;
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
  const [storageNote, setStorageNote] = useState('');
  /** One re-issue per mount — see the note in `load`. */
  const reissued = useRef(false);

  const load = useCallback(async () => {
    if (!token) return;
    // THE GRANT MUST NAME THE RECORD. Requests live in a record family added after most people signed
    // their interactions grant, and a grant that does not name a record cannot write it — so someone
    // asking for a way to reach you is refused at your vault, through no fault of theirs.
    //
    // FORCED, and once per mount: `activateInteractionsIfNeeded` skips when the grant is current, and by
    // the DO's staleness gate it IS current — the resolution records are issued but deliberately not
    // required, because requiring them declared every existing grant insufficient and took the estate
    // offline. So the surface that needs the family asks for the re-issue itself.
    //
    // Not on every load: a wallet home signs with a device prompt, and a page that prompts each time it
    // renders is one nobody will keep open.
    if (agentAddress && session && !reissued.current) {
      reissued.current = true;
      const re = await activateInteractionsIfNeeded(agentAddress as Address, resolveVia(profile?.credential, session.via), { token }, true)
        .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
      // NOT swallowed. A silent failure here looks identical to success and leaves the person unable to
      // receive requests they were never told they could not receive.
      if (!re.ok) setStorageNote(`Requests to reach your agents can't be received yet: ${re.error}`);
      else setStorageNote('');
    }
    const r = await fetch('/a2a/resolution/requests', { headers: { authorization: `Bearer ${token}` } });
    const b = (await r.json().catch(() => ({}))) as { requests?: PendingRequest[]; error?: string };
    if (!r.ok) { setErr(b.error ?? `could not read requests (${r.status})`); setRows([]); return; }
    setRows(b.requests ?? []);
  }, [token, agentAddress, session, profile?.credential]);
  useEffect(() => { void load(); }, [load]);

  if (!session || !token) return null;
  // ONLY REQUESTS ADDRESSED TO YOU. The record family holds both ends of an exchange — what someone
  // asked of you, and what you are waiting on from them — and rendering a "sent" row here read its
  // absent `requester` and threw, taking the whole section down with it. The crash was invisible: the
  // page kept working and the card below simply never appeared, which cost an afternoon of grepping
  // bundles to decide whether that card had even deployed.
  const pending = (rows ?? []).filter((x) =>
    x.kind !== 'resolution.invitation.sent' && !!x.requester && (x.status ?? 'pending') === 'pending');
  // A storage problem is shown even with nothing pending: it is the reason nothing is pending.
  if (!pending.length && !storageNote) return null;

  /** The agents this person could disclose — theirs, of the kind asked for. An UNNAMED one is the usual
   *  answer here: it is unlisted precisely because it has no name, which is why a grant is needed. */
  const candidatesFor = (wants: string) =>
    agents.filter((a) => (a.kind ?? '').includes(wants) || (a.name ?? '').endsWith(`.${wants}`));

  async function approve(req: PendingRequest) {
    const requester = req.requester ?? '';
    const options = candidatesFor(req.wants ?? 'treasury');
    // NO SILENT DEFAULT when there is a choice. Which agent gets disclosed is the whole decision, and
    // defaulting to the first one means a mis-click discloses an agent the person never picked — the
    // exact error this feature exists to prevent, made by the feature. One option needs no choosing.
    const target = options.length === 1 ? options[0]!.agent : pickedFor[requester];
    if (!target) {
      setErr(options.length ? 'Pick which one they may reach.' : 'You have no agent of that kind to give them a way to reach.');
      return;
    }
    setBusy(requester); setErr('');
    try {
      // Signed by the person deciding — that signature is what makes the grant theirs rather than the
      // server's. The route verifies it against their agent on chain before delivering anything.
      const via = resolveVia(profile?.credential, session!.via);
      const cred = await connectedCredential(via, agentAddress as Address, token!);
      const body = { session: token, requester: req.requester, targetAgent: target, wants: req.wants };
      await ensureCsrfToken();
      const probe = await fetch('/a2a/resolution/grant', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(body),
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
      {storageNote && <p style={errorText} data-testid="resolution-storage-note">{storageNote}</p>}
      {pending.map((req) => {
        const requester = req.requester!;
        const options = candidatesFor(req.wants ?? 'treasury');
        return (
          <div key={`${requester}:${req.wants}`} style={cardSty} data-testid={`resolution-request-${requester.toLowerCase()}`}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              Someone wants a way to reach your {req.wants}
            </div>
            <div style={{ marginTop: 4 }}><AddressChip address={requester} /></div>
            {req.purpose && <p style={{ fontSize: 12.5, margin: '6px 0 0' }}>“{req.purpose}”</p>}
            <p style={{ ...mutedText, fontSize: 11.5, margin: '6px 0 0', lineHeight: 1.5 }}>
              Approving lets them <strong>find</strong> the agent you pick — nothing more. They will be able to send to it.
              They will not be able to take anything from it, and you can revoke this later.
            </p>
            {options.length > 1 && (
              <select
                className="input" style={{ marginTop: 8, fontSize: 12 }} data-testid={`resolution-target-${requester.toLowerCase()}`}
                value={pickedFor[requester] ?? ''}
                onChange={(e) => setPickedFor({ ...pickedFor, [requester]: e.target.value })}
              >
                <option value="">Which one may they reach?</option>
                {options.map((o) => <option key={o.agent} value={o.agent}>{o.name || `unnamed ${req.wants} · ${o.agent.slice(0, 10)}…`}</option>)}
              </select>
            )}
            {/* NOTHING TO SHARE IS A STEP, NOT A WALL. Someone is trying to pay them and they have no
                treasury — the request is answerable, it just needs one to exist first. Saying only "you
                have no treasury" leaves both people stuck on a thing either could fix in a minute. */}
            {!options.length && (
              <div style={{ marginTop: 6 }}>
                <p style={{ ...mutedText, fontSize: 11.5, lineHeight: 1.5 }}>
                  You have no {req.wants} yet — that is why they could not reach one. Create one and come back to this
                  card; nothing is sent until you do.
                </p>
                <a className="btn ghost" style={{ fontSize: 12, display: 'inline-block', marginTop: 6 }} href="/treasuries" data-testid={`resolution-create-${requester.toLowerCase()}`}>
                  Create a {req.wants}
                </a>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <BusyButton
                busy={busy === req.requester} busyLabel="Granting…"
                disabled={!options.length || (options.length > 1 && !pickedFor[requester])}
                className="btn primary" data-testid={`resolution-approve-${requester.toLowerCase()}`}
                onClick={() => void approve(req)}
              >Give them a way to reach it</BusyButton>
            </div>
          </div>
        );
      })}
    </SectionShell>
  );
}
