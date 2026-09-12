// GET /connect/name-info?name=<agent-name> → does the workspace exist, and which
// custody credentials does it have? Drives the connect UI: show "passkey" and/or
// "wallet" based on the agent's ACTUAL on-chain custodian set.
//   { exists: false, name } | { exists: true, name, agent, hasEoa, hasPasskey }
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { jsonCors, preflight, type FnContext } from '../_lib/server-broker';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { qualifiedAgentName as fullName } from '../../src/lib/domain';
import { passkeySigningAvailable } from '../lib/p256-availability';



export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const raw = new URL(request.url).searchParams.get('name');
  if (!raw || !raw.trim()) return jsonCors({ error: 'name required' }, request, 400);
  const name = fullName(raw);
  const rpcUrl = (env.RPC_URL || DEFAULT_RPC_URL);

  const naming = new AgentNamingClient({
    rpcUrl,
    chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry,
    universalResolver: CONTRACTS.agentNameUniversalResolver,
  });
  const agent = await naming.resolveName(name);
  if (!agent) return jsonCors({ exists: false, name }, request);

  const accounts = new AgentAccountClient({
    rpcUrl,
    chainId: CHAIN_ID,
    entryPoint: CONTRACTS.entryPoint,
    factory: CONTRACTS.agentAccountFactory,
  });
  // `deployed` is the orphan-detection signal. The PermissionlessSubregistry
  // accepts a `register(label, owner)` from any caller and does not require
  // `owner` to be deployed, so historical relayer-paid registrations (pre-
  // `af17ea8`, before register was bundled atomically into the deploy userOp)
  // can leave a name pointing at an address that never received code. The
  // downstream UX MUST treat `exists: true, deployed: false` as "incomplete
  // previous setup" and refuse to use `agent` as a `personAgent` argument —
  // every `executeCall` against an undeployed sender reverts with AA20 in
  // the bundler and surfaces as a confusing 500 several steps deeper in the
  // flow (live-debug 2026-06-01). `custodianCount` / `passkeyCount` against
  // an undeployed contract return 0 (empty calldata decodes to default),
  // hence `hasEoa: false, hasPasskey: false` for orphans — but that is a
  // weaker signal than the explicit `deployed` boolean. Per ADR-0013 this
  // is a single read; no fallback path if `getCode` fails.
  const [custodianCount, pkCount, deployed, connection, p256] = await Promise.all([
    accounts.custodianCount(agent),
    accounts.passkeyCount(agent),
    accounts.isDeployed(agent),
    // Connection-bootstrap record (spec 280): the opt-in, owner-published `how-to-connect` hint.
    // null when the owner hasn't published one — the UI then shows all credential buttons (ADR-0013:
    // one read, absence is an answer, no second mechanism).
    naming.getConnectionInfo(name).catch(() => null),
    // Whether a passkey can be VERIFIED on this chain at all — an account may hold registered passkeys
    // on a chain with no P-256 verifier, where none of them can ever sign.
    passkeySigningAvailable(rpcUrl),
  ]);
  const eoaCount = custodianCount - pkCount;
  // CORS (registered relying origins): the connect UIs of relying apps (gather27-web's org-handle
  // availability, field/engage connect screens) call this cross-origin; it is public chain state.
  return jsonCors({
    exists: true,
    name,
    agent,
    deployed,
    hasEoa: eoaCount > 0n,
    hasPasskey: pkCount > 0n,
    // spec 280 — published connection bootstrap (kind + optional pre-select address). Null if unset.
    connectionKind: connection?.kind ?? null,
    connectionAddress: connection?.address ?? null,
    // `null` = could not be determined; the UI must treat that as "offer it", not as "unsupported".
    passkeySigningAvailable: p256,
  }, request);
};

export const onRequestOptions = async ({ request }: { request: Request }): Promise<Response> => preflight(request);
