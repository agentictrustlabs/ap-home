// /connect/inbox — the owner's Home inbox surface (spec 310 W3).
//
//   GET                                → full inbox view (session required)
//   POST { action:'read'|'archive', messageId }
//   POST { action:'transition', interactionId, transition, reason? }
//   POST { action:'transition', transition:'approve', interactionId, mandate }
//     — approve WITH a signed InteractionMandateV1 (spec 310 W5): the mandate's
//       digest is RE-DERIVED and ERC-1271-verified against the person SA before
//       the audited approve transition carries its delegation hash as the
//       case's AuthorityRef.
//
// The session gate binds the caller to the person SA; the interactions state
// machine then enforces the ROLE for every transition (a session alone cannot
// approve a case it is not the responder/resource-owner of). All decisions and
// admissions are audit-backed fail-closed inside src/home/inbox-data.ts.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import type { InteractionMandateV1, InteractionTransitionType } from '@agenticprimitives/interactions';
import type { Address, Hex } from '@agenticprimitives/types';
import { getServer, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { readInboxView, applyMessageAction, applyCaseTransition, applyApproveWithMandate } from '../../src/home/inbox-data';
import { mandateDigest } from '../../src/home/mandate';
import { appendControlEvent } from './control-events';

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  return origin && isAllowedClientOrigin(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' }
    : {};
}
const jsonCors = (body: unknown, request: Request, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(request) } });

export const onRequestOptions = async ({ request }: FnContext): Promise<Response> =>
  new Response(null, { status: 204, headers: cors(request) });

async function personFrom(request: Request, env: FnContext['env']): Promise<string | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: resolveOrigin(request, env) });
  if (!v.ok) return null;
  return (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  return jsonCors(await readInboxView(env.AUTH_CODES, person), request);
};

const OWNER_TRANSITIONS: readonly InteractionTransitionType[] = ['view', 'triage', 'ask-info', 'approve', 'deny', 'revoke'];

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);

  const body = (await request.json().catch(() => null)) as
    | { action?: string; messageId?: string; interactionId?: string; transition?: string; reason?: string; mandate?: InteractionMandateV1 }
    | null;

  try {
    if (body?.action === 'read' || body?.action === 'archive') {
      if (!body.messageId) return jsonCors({ error: 'messageId required' }, request, 400);
      await applyMessageAction(env.AUTH_CODES, person as Address, body.messageId, body.action === 'read' ? 'read' : 'archived');
      return jsonCors({ ok: true }, request);
    }
    if (body?.action === 'transition') {
      const transition = body.transition as InteractionTransitionType;
      // Only owner-review moves are reachable from this surface; requester-side
      // and issuance moves arrive via delivery / authority flows, never the UI.
      if (!body.interactionId || !OWNER_TRANSITIONS.includes(transition)) {
        return jsonCors({ error: 'interactionId + owner transition required' }, request, 400);
      }

      if (transition === 'approve' && body.mandate) {
        // W5: approve + issue. ERC-1271 over the RE-DERIVED mandate digest.
        const accounts = new AgentAccountClient({
          rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
          chainId: CHAIN_ID,
          entryPoint: CONTRACTS.entryPoint,
          factory: CONTRACTS.agentAccountFactory,
        });
        const updated = await applyApproveWithMandate(
          env.AUTH_CODES,
          person as Address,
          body.interactionId,
          body.mandate,
          async (digest, signature) => {
            try {
              return await accounts.isValidSignature(person as Address, digest, signature as Hex);
            } catch {
              return false;
            }
          },
          mandateDigest,
        );
        // The mandate (scoped delegation + signed intent) is the issued artifact.
        await appendControlEvent(env, person as Address, 'credential-issued', [
          { kind: 'delegation', hash: body.mandate.delegationHash },
        ]);
        return jsonCors({ ok: true, case: updated }, request);
      }

      const updated = await applyCaseTransition(env.AUTH_CODES, person as Address, body.interactionId, transition, body.reason);
      // Decisions land on the control-plane timeline (spec 310 W4); view/triage
      // are navigation, not decisions.
      if (transition === 'approve' || transition === 'deny' || transition === 'ask-info' || transition === 'revoke') {
        await appendControlEvent(env, person as Address, 'inbox-decision', updated.authorityRefs.slice(-1));
      }
      return jsonCors({ ok: true, case: updated }, request);
    }
    return jsonCors({ error: 'unknown action' }, request, 400);
  } catch (e) {
    return jsonCors({ error: e instanceof Error ? e.message : String(e) }, request, 409);
  }
};
