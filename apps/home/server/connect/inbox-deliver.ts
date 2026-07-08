// POST /connect/inbox/deliver — inbound signed-envelope delivery (spec 309 §7
// "direct app↔inbox" profile; spec 310 W3). The transport half: any agent (an
// A2A worker, a relying app's service agent, another Home) POSTs a
// MessageEnvelopeV1 + body for a recipient this Home hosts.
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

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
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
    await deliverToInbox(env.AUTH_CODES, recipient, {
      envelope: body.envelope,
      bodyText: body.bodyText,
      interactionCase: body.interactionCase,
      card: body.card,
      conversation: body.conversation,
    });
    return json({ ok: true, messageId: body.envelope.id }, 200);
  } catch (e) {
    // Rejections were already audited as `denied` inside the admitter.
    return json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
};
