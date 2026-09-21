// A PER-APP READ GRANT, MINTED AT CONNECT — spec 341 §4.3b made part of the ceremony (spec 412 W6).
//
// An app that reads a person's records fast (one `record.get` under its own bearer, no harness) holds a scoped,
// revocable delegation the person signed: person → the interactions service SA, naming only the record families the
// registry declares for that client (`read_grant.resources`). Until now that grant was issued by hand on a Home
// panel; a client whose registration declares one gets it in the SAME connect that mints its site grant or ask-as-me
// wire — one more signature in a ceremony that already signs, and for KMS / demo custody no prompt at all.
//
// Best-effort and SAID: the connect stands without it (the app then reads nothing of hers and must say so); a grant
// that could not be minted is a console line, never a failed sign-in. Read only by construction. Revocable alone,
// under App grants at the Home.
import type { Address } from '@agenticprimitives/types';
import { issueReadGrant } from '../lib/read-grant-build';
import { putReadGrant } from '../lib/read-grants';
import { INTERACTIONS_SERVICE_SA, MCP_SERVER_ID } from '../lib/inbox-delivery';
import { whitelabel } from '../whitelabel/config';
import type { SignHash } from './resolution';

export async function issueAppReadGrantIfDeclared(clientId: string, personSA: Address, signHash: SignHash): Promise<{ issued: boolean; reason?: string }> {
  const client = whitelabel.relyingApps.find((a) => a.client_id === clientId);
  const resources = client?.read_grant?.resources;
  if (!resources?.length) return { issued: false, reason: 'the client declares no read grant' };
  if (!INTERACTIONS_SERVICE_SA) return { issued: false, reason: 'no interactions service agent is provisioned' };
  try {
    const grant = await issueReadGrant({ personSA, serviceSA: INTERACTIONS_SERVICE_SA, resources, server: MCP_SERVER_ID, signHash });
    await putReadGrant(personSA, clientId, grant);
    return { issued: true };
  } catch (e) {
    console.warn(`[connect ${clientId}] read grant not issued (the app reads nothing of hers):`, e instanceof Error ? e.message : String(e));
    return { issued: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
