'use client';
// ONE APP REQUEST: SET UP A HOUSEHOLD (src/lib/household-setup.ts). A family app (Family Field) collects the household's
// people and preferences itself and writes them to the household's own agent; this page is the one approval only Home
// can give. It opens as a small window from the app and tells the app when it is done; the app confirms by reading.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { activateInteractionsIfNeeded, resolveVia } from '../../../src/home/onboarding';
import { createAgentWithBirthrights, enableAgentPlanes } from '../../../src/components/portal/ManagedAgents';
import { listManagedAgentsStrict } from '../../../src/connect-client';
import { assignDefaultArchetype } from '../../../src/home/default-archetype';
import { CLIENT_DEFAULTS } from '../../../src/lib/client-defaults';
import { vaultReadWithDelegation, vaultWriteWithDelegation } from '../../../src/lib/vault-client';
import type { DelegationWire } from '../../../src/lib/delegation';
import { whitelabel } from '../../../src/whitelabel/config';
import { finishApprovalWindow } from '../../../src/lib/approval-window';
import {
  HOUSEHOLD_SETUP_MESSAGE, householdSetupRequestOf, householdSetupReturn, setUpHousehold,
  type HouseholdSetupOutcome, type HouseholdSetupRequest,
} from '../../../src/lib/household-setup';

export default function HouseholdSetupPage() {
  const { session, agentAddress, agentName, personName, profile } = useSession();
  const [request, setRequest] = useState<HouseholdSetupRequest | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [progress, setProgress] = useState(''), [slow, setSlow] = useState(false);
  const [done, setDone] = useState<HouseholdSetupOutcome | null>(null);
  /** The approval is done and the window could not close itself (or was opened as a tab). */
  const [stayed, setStayed] = useState(false);
  useEffect(() => {
    const read = householdSetupRequestOf(location.search, whitelabel.relyingApps, (client) => !!CLIENT_DEFAULTS[client]?.family);
    if (read.ok) setRequest(read.request); else setError(read.error);
  }, []);
  useEffect(() => { setSlow(false); if (!busy) return; const t = setTimeout(() => setSlow(true), 20000); return () => clearTimeout(t); }, [busy]);
  const wrongHome = !!request?.member && !!agentAddress && request.member !== agentAddress.toLowerCase();
  // Tell the app (a hint: it confirms by reading the person's households) and CLOSE this window: the person goes back to
  // the app with nothing left over it. A browser that refuses the close gets "You can close this window".
  const notify = (outcome: HouseholdSetupOutcome) => {
    if (!request) return;
    const told = finishApprovalWindow(window, {
      targetOrigin: new URL(request.returnTo).origin,
      message: { type: HOUSEHOLD_SETUP_MESSAGE, attempt: request.attempt, household: outcome.household, action: outcome.created ? 'created' : 'ready' },
      onStillOpen: () => setStayed(true),
    });
    if (!told) setStayed(true);
  };
  const approve = async () => {
    if (!request || !session || !agentAddress || wrongHome || busy) return;
    setBusy(true); setError('');
    const token = session.token, person = agentAddress as Address, via = resolveVia(profile?.credential, session.via);
    const links = () => listManagedAgentsStrict(token);
    const stewardship = async (household: string): Promise<DelegationWire | null> =>
      ((await links()).find((a) => a.agent.toLowerCase() === household.toLowerCase())?.stewardshipDelegation as DelegationWire | undefined) ?? null;
    try {
      const outcome = await setUpHousehold(person, request, {
        list: async () => (await links()).map((a) => ({ agent: a.agent, kind: a.kind, relationship: a.relationship })),
        create: async (name) => {
          setProgress('Creating your household…');
          const made = await createAgentWithBirthrights({ kind: 'household', parent: person, person, via, displayName: name }, token, setProgress);
          if (!made.ok) throw new Error(made.error);
          return made.result.agent;
        },
        ready: async (household) => {
          const planes = await enableAgentPlanes(household, via, token, setProgress);
          if (!planes.ok) throw new Error(planes.error);
          setProgress('Setting up its playbook…');
          const own = CLIENT_DEFAULTS[request.client]?.householdArchetype;
          let playbook = await assignDefaultArchetype(household, 'household', token, own);
          if (!playbook.ok && own) playbook = await assignDefaultArchetype(household, 'household', token);
          if (!playbook.ok) throw new Error(`household playbook: ${playbook.reason}`);
        },
        name: async (household, name) => {
          setProgress('Naming your household…');
          const wire = await stewardship(household);
          if (!wire) throw new Error('Your stewardship of the household is not readable yet, so it could not be named. Try again in a moment.');
          // keep what the profile already holds (a picture, a description); only the name changes
          const held = ((await vaultReadWithDelegation<Record<string, unknown>>(wire, 'org.profile').catch(() => null)) ?? {}) as Record<string, unknown>;
          await vaultWriteWithDelegation(wire, 'org.profile', { ...held, v: 1, displayName: name });
          const r = await fetch('/connect/related-orgs', {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ person, orgAgent: household.toLowerCase(), orgProfile: { displayName: name, website: typeof held.website === 'string' ? held.website : '', photo: typeof held.photo === 'string' ? held.photo : '' } }),
          });
          if (!r.ok) throw new Error('The household was named in its own record, but Home could not show the name on your link yet.');
        },
        renewPerson: async () => {
          setProgress('Renewing your storage session…');
          const renewed = await activateInteractionsIfNeeded(person, via, { token });
          if (!renewed.ok) throw new Error(`your storage session: ${renewed.error}`);
        },
        receipt: localStorage,
      });
      setDone(outcome);
      notify(outcome);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false); setProgress('');
    }
  };
  const back = () => {
    if (!request) return;
    if (window.opener && !window.opener.closed) { window.opener.focus(); window.close(); }
    setTimeout(() => location.assign(householdSetupReturn(request.returnTo, request.attempt)), 150);
  };
  return <section style={{ maxWidth: 480, margin: '6vh auto', padding: 24 }}>
    <p>Approving as {personName ?? agentName ?? agentAddress ?? 'your Home'}</p>
    <h1>{done ? 'Your household is ready' : request?.household ? 'Finish your household?' : 'Create your household?'}</h1>
    {request && !done && <>
      <p><strong>{request.appName}</strong> asks to {request.household ? 'finish setting up' : 'set up'} the household <strong>{request.name}</strong>.</p>
      <ul>
        {!request.household && <li>A household agent is created. You are its steward.</li>}
        <li>Its private storage is switched on, and its playbook is the one {request.appName} uses for a household.</li>
        <li>Its name is shown as “{request.name}”. You can change it at Home later.</li>
        <li>Your own storage session is renewed, so the household can confirm you as its steward.</li>
      </ul>
      <p>{request.appName} then saves your household’s people and plans to the household’s own agent. Nothing about your children is sent here.</p>
      {wrongHome && <p role="alert">This Home is signed in as a different person from {request.appName}. Sign in to the same account in both windows, then try again.</p>}
      {busy && <p role="status">{progress || 'Saving your approval…'}</p>}
      {slow && busy && <p>This is taking longer than usual. Keep this window open; you do not need to approve again.</p>}
      <button type="button" className="btn primary" disabled={busy || wrongHome || !session} onClick={() => void approve()}>{busy ? 'Setting up…' : request.household ? 'Approve and finish' : 'Approve and create'}</button>
      <button type="button" className="btn" disabled={busy} onClick={() => window.close()}>Not now</button>
    </>}
    {error && <p role="alert">{error}</p>}
    {done && request && <>
      <p role="status">{done.created ? 'Created and ready.' : 'Ready.'} {stayed ? `You can close this window. ${request.appName} checks your household and saves what you told it.` : `Taking you back to ${request.appName}…`}</p>
      <button type="button" className="btn primary" onClick={back}>Done — back to {request.appName}</button>
    </>}
  </section>;
}
