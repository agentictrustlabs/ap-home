// POST /connect/inbox/deliver — inbound delivery for a recipient this Home hosts
// (spec 309 §7 "direct app↔inbox" profile; spec 310 W3).
//
// AUTHENTICATED SINCE spec 341 §5.2. It was not, and the header here used to
// claim "signed-envelope delivery" while nothing verified a signature: no bearer,
// no session, `access-control-allow-origin: *`, and the only check was that the
// recipient's label resolved to `envelope.to[0]` — i.e. that the message was
// correctly ADDRESSED. `envelope.from` was taken on trust, so anyone who knew a
// person's label could inject a message into their inbox as any sender.
//
// The caller now presents an id_token THIS Home minted, and `envelope.from` MUST
// equal the verified subject. A sender claim is no longer a claim.
//
// This is authentication, not authority: holding a token permits nothing, and a
// message is never authority (spec 309 §4.2, ADR-0041).
//
// Admission is the packages' audited fail-closed pipeline (validate → body-hash
// → audit-accept → commit; case submit/admit transitions audited the same way).
// A message is never authority — nothing here grants anything (spec 309 §4).
import type { ConversationDescriptorV1, MessageEnvelopeV1 } from '@agenticprimitives/fabric/messaging';
import type { ActionCardV1, InteractionCaseV1 } from '@agenticprimitives/fabric/interactions';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import type { Address } from '@agenticprimitives/types';
import type { FnContext } from '../_lib/server-broker';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { nameLabel } from '../../src/lib/domain';
import { deliverToInbox } from '../../src/home/inbox-data';
import { makeBodyStoreFactory } from './message-body-store';
import { makeInboxKv } from '../lib/inbox-store';
import { importJwks } from '@agenticprimitives/connect';
import { getServer, ownIssuer } from '../_lib/server-broker';
import { bearerFrom, verifyRelyingClientIdToken } from '../_lib/relying-token';

// `authorization` must be allowed through, or a browser client cannot present the token this endpoint
// now requires. The origin stays `*`: the token is the gate, not the origin — an origin check would be
// a second, weaker mechanism (ADR-0013).
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
};
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

interface DeliverBody {
  /** The recipient's subdomain label — must resolve on-chain to the envelope's addressee. */
  label?: string;
  envelope?: MessageEnvelopeV1;
  bodyText?: string;
  interactionCase?: InteractionCaseV1;
  card?: ActionCardV1;
  conversation?: ConversationDescriptorV1;
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as DeliverBody | null;
  const label = (body?.label ?? '').trim().toLowerCase();
  if (!/^[a-z0-9-]{1,63}$/.test(label) || !body?.envelope || typeof body.bodyText !== 'string') {
    return json({ error: 'label + envelope + bodyText required' }, 400);
  }

  // ── spec 341 §5.2 — authenticate the SENDER, before anything is admitted ──────────────────────
  // Ordering matters: this runs before the on-chain name read, so an unauthenticated caller cannot
  // use this endpoint as a free naming-resolution oracle, and cannot make us spend an RPC call.
  const token = bearerFrom(request);
  if (!token) return json({ error: 'authorization required' }, 401);
  const { jwks } = await getServer(env);
  const subject = await verifyRelyingClientIdToken(token, await importJwks(jwks), ownIssuer(request, env));
  if (!subject) return json({ error: 'invalid or unrecognised token' }, 401);

  const claimedFrom = body.envelope.from?.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase();
  if (!claimedFrom) return json({ error: 'envelope.from must carry the sending agent' }, 400);
  if (claimedFrom !== subject) {
    // The whole point. A caller may deliver AS ITSELF and as nothing else; `from` is now bound to a
    // signature this Home verified rather than to whatever the body asserted.
    return json({ error: 'envelope.from does not match the authenticated sender' }, 403);
  }

  // Label → recipient SA, one on-chain mechanism (reverse-confirmed forward
  // resolution lives inside AgentNamingClient — ADR-0012/0013). The envelope
  // must be addressed to the RESOLVED agent; deliverToInbox re-checks it.
  const naming = new AgentNamingClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
    chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry,
    universalResolver: CONTRACTS.agentNameUniversalResolver,
  });
  const recipient = body.envelope.to[0]?.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase() as Address | undefined;
  if (!recipient) return json({ error: 'envelope.to[0] must carry the recipient agent' }, 400);
  const name = await naming.reverseResolve(recipient);
  if (!name || nameLabel(name) !== label) {
    return json({ error: 'label does not resolve to the addressed agent' }, 403);
  }

  try {
    await deliverToInbox(await makeInboxKv(env, recipient), recipient, {
      envelope: body.envelope,
      bodyText: body.bodyText,
      interactionCase: body.interactionCase,
      card: body.card,
      conversation: body.conversation,
    }, await makeBodyStoreFactory(env)(recipient));
    return json({ ok: true, messageId: body.envelope.id }, 200);
  } catch (e) {
    // Rejections were already audited as `denied` inside the admitter.
    return json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
};
