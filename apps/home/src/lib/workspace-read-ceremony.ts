// The /workspace-read contract, as pure functions — the `/choose-treasury` split (lib/treasury-ceremony.ts), for the
// ceremony that lets a person, as the CUSTODIAN of a service agent they chartered, mint that agent's A2A signing wire for
// `library.granted.read` ("Let <name>.svc read works it is granted").
//
// THE REQUEST a relying app (Source Publishing) sends the person to:
//
//   /workspace-read?client_id=…&redirect_uri=…&state=…&agent=0x…
//
//   client_id     WHO is asking — resolved through the same registry every gate uses (`primeRelyingClient`).
//   redirect_uri  WHERE the answer goes — EXACT match against that client's registered redirect_uris (CN-1).
//   state         opaque, echoed back unchanged.
//   agent         the service agent (0x… SA) whose wire to sign — the workspace the app asked a publisher to grant.
//
// THE ANSWER is a full-page redirect to the registered redirect_uri:
//
//   enabled   ?read_wire=enabled&agent=0x…&read_wire_hash=0x…&state=…
//   refused   ?read_wire_error=denied|not_custodian|not_service|failed&agent=0x…&state=…
//
// Nothing here trusts its input; `workspaceReadRefusal` is the only function that says yes.
import { refusalFor, type TreasuryCeremonyClient, type TreasuryRefusal } from './treasury-ceremony';

export interface WorkspaceReadRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  agent: string;
}

export type WorkspaceReadRefusalCheck = TreasuryRefusal['check'] | 'agent';
export interface WorkspaceReadRefusal { check: WorkspaceReadRefusalCheck; detail: string }

/** The four outcomes the app is told about besides success. */
export type WorkspaceReadError = 'denied' | 'not_custodian' | 'not_service' | 'failed';

export function parseWorkspaceReadRequest(href: string): WorkspaceReadRequest | null {
  let p: URLSearchParams;
  try { p = new URL(href).searchParams; } catch { return null; }
  const clientId = (p.get('client_id') ?? '').trim();
  const redirectUri = (p.get('redirect_uri') ?? '').trim();
  if (!clientId || !redirectUri) return null;
  return { clientId, redirectUri, state: p.get('state') ?? '', agent: (p.get('agent') ?? '').trim().toLowerCase() };
}

/** The gate: the client and its redirect exactly as /choose-treasury checks them, then an agent address. */
export function workspaceReadRefusal(req: WorkspaceReadRequest | null, client: TreasuryCeremonyClient | null): WorkspaceReadRefusal | null {
  const base = refusalFor(req ? { clientId: req.clientId, redirectUri: req.redirectUri, state: req.state, label: '' } : null, client);
  if (base) return base;
  if (!/^0x[0-9a-f]{40}$/.test(req!.agent)) return { check: 'agent', detail: 'agent must be the service agent\'s 0x address' };
  return null;
}

/** The URL the person leaves on. `redirectUri` MUST be one `workspaceReadRefusal` cleared — this builds, it does not check. */
export function workspaceReadReturnUrl(
  redirectUri: string,
  state: string,
  agent: string,
  result: { hash: string } | { error: WorkspaceReadError },
): string {
  const url = new URL(redirectUri);
  if ('error' in result) url.searchParams.set('read_wire_error', result.error);
  else {
    url.searchParams.set('read_wire', 'enabled');
    url.searchParams.set('read_wire_hash', result.hash);
  }
  url.searchParams.set('agent', agent.toLowerCase());
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * MAY THIS PERSON SIGN THE WIRE? Decided before any signature is asked for, in words. `isService` is the agent's class
 * (a `.svc` service, not an org or a person); `custodian` is `canGrantAs(agent, credential)` — the on-chain custody read
 * (isCustodian / hasPasskey). Only custody can sign as the agent: being in the person's tree, or stewarding it, is not.
 */
export function workspaceReadAdmission(o: { agentLabel: string; isService: boolean; custodian: boolean }):
  | { ok: true }
  | { ok: false; error: Exclude<WorkspaceReadError, 'denied' | 'failed'>; said: string } {
  if (!o.isService) return { ok: false, error: 'not_service', said: `${o.agentLabel} is not a service agent you chartered — this signs a service's own library-read wire (an organization signs through member routing).` };
  if (!o.custodian) return { ok: false, error: 'not_custodian', said: `You can’t sign this: ${o.agentLabel} is custodied by a different credential than the one you are signed in with. Whoever custodies it has to let it read.` };
  return { ok: true };
}
