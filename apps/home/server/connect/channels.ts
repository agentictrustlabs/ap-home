// /connect/channels — community channels (spec 313 §3). Slack/Discord-shaped
// boards over spec 312 primitives: each channel is a ConversationDescriptorV1
// (`participantPolicy: 'open-to-context'`) stored WITH its messages in a
// per-community KV document (shared state, unlike per-person inboxes).
//
//   GET  ?communityId=…                          → { channels } (member-gated)
//   POST { action:'create', communityId, title }
//   POST { action:'post', communityId, channelId, bodyText }
//
// Gates, fail-closed:
//   1. session required for read AND post — no anonymous community reads;
//   2. MEMBERSHIP = a current directory listing in the community (spec 312 —
//      joining channels and being discoverable are the same opt-in consent);
//   3. posts are envelope-shaped (validated, body-hash-bound) and audited to
//      the community audit log BEFORE commit (spec 291 discipline).
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import {
  generateConversationId,
  generateMessageId,
  sha256Hex32,
  validateConversationDescriptor,
  validateMessageEnvelope,
  type ConversationDescriptorV1,
  type MessageEnvelopeV1,
} from '@agenticprimitives/messaging';
import { isListingCurrent } from '@agenticprimitives/home';
import type { Address } from '@agenticprimitives/types';
import { getServer, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { homeCaip10 } from '../../src/home/manifest';
import { homeAuditSink } from '../../src/home/inbox-data';
import type { IndexedListing } from './directory';

const CHANNELS_KEY = (communityId: string): string => `channels:${communityId.toLowerCase()}`;
const DIRECTORY_KEY = (communityId: string): string => `directory:${communityId.toLowerCase()}`;

export interface ChannelMessageV1 {
  envelope: MessageEnvelopeV1;
  bodyText: string;
  /** Poster's directory display name at post time (render convenience). */
  authorName: string;
}

export interface ChannelV1 {
  descriptor: ConversationDescriptorV1;
  title: string;
  createdBy: string;
  messages: ChannelMessageV1[];
}

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

/** Membership gate: the person has a CURRENT listing in the community. Returns
 *  their display name, or null (⇒ not a member — fail closed). */
async function memberName(env: FnContext['env'], communityId: string, person: string): Promise<string | null> {
  const raw = await env.AUTH_CODES.get(DIRECTORY_KEY(communityId));
  const rows = raw ? (JSON.parse(raw) as IndexedListing[]) : [];
  const me = homeCaip10(person as Address).toLowerCase();
  const now = new Date().toISOString();
  const mine = rows.find((l) => l.listing.subject.toLowerCase() === me && isListingCurrent(l.listing, now));
  return mine?.listing.displayName ?? null;
}

async function readChannels(env: FnContext['env'], communityId: string): Promise<ChannelV1[]> {
  const raw = await env.AUTH_CODES.get(CHANNELS_KEY(communityId));
  return raw ? (JSON.parse(raw) as ChannelV1[]) : [];
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  const communityId = (new URL(request.url).searchParams.get('communityId') ?? '').trim().toLowerCase();
  if (!communityId) return jsonCors({ error: 'communityId required' }, request, 400);
  const name = await memberName(env, communityId, person);
  if (!name) return jsonCors({ error: 'join this community first — publish a directory listing to enter its channels' }, request, 403);
  return jsonCors({ channels: await readChannels(env, communityId), you: name }, request);
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  const body = (await request.json().catch(() => null)) as
    | { action?: string; communityId?: string; channelId?: string; title?: string; bodyText?: string }
    | null;
  const communityId = (body?.communityId ?? '').trim().toLowerCase();
  if (!communityId) return jsonCors({ error: 'communityId required' }, request, 400);

  const authorName = await memberName(env, communityId, person);
  if (!authorName) {
    return jsonCors({ error: 'join this community first — publish a directory listing to enter its channels' }, request, 403);
  }
  const me = homeCaip10(person as Address);

  try {
    if (body?.action === 'create') {
      const title = (body.title ?? '').trim();
      if (!title || title.length > 80) return jsonCors({ error: 'title required (≤ 80 chars)' }, request, 400);
      const descriptor: ConversationDescriptorV1 = {
        version: 'ap.conversation.v1',
        id: generateConversationId(),
        owner: me,
        title,
        participants: [me],
        contextRefs: [{ kind: 'community', id: communityId }],
        participantPolicy: 'open-to-context',
        createdAt: new Date().toISOString(),
      };
      const errors = validateConversationDescriptor(descriptor);
      if (errors.length > 0) return jsonCors({ error: `invalid channel: ${errors.join(', ')}` }, request, 400);
      const channels = await readChannels(env, communityId);
      if (channels.some((c) => c.title.toLowerCase() === title.toLowerCase())) {
        return jsonCors({ error: 'a channel with this title already exists' }, request, 409);
      }
      channels.push({ descriptor, title, createdBy: authorName, messages: [] });
      await env.AUTH_CODES.put(CHANNELS_KEY(communityId), JSON.stringify(channels));
      return jsonCors({ ok: true, channelId: descriptor.id }, request);
    }

    if (body?.action === 'post') {
      const bodyText = (body.bodyText ?? '').trim();
      if (!body.channelId || !bodyText) return jsonCors({ error: 'channelId + bodyText required' }, request, 400);
      const channels = await readChannels(env, communityId);
      const channel = channels.find((c) => c.descriptor.id === body.channelId);
      if (!channel) return jsonCors({ error: 'unknown channel' }, request, 404);

      const now = new Date().toISOString();
      const envelope: MessageEnvelopeV1 = {
        version: 'ap.message.v1',
        id: generateMessageId(),
        conversationId: channel.descriptor.id,
        kind: 'plain',
        from: me,
        // Shared-board addressing: the channel descriptor's owner stands for
        // the board; per-member fan-out is a W4 concern (spec 313 §6).
        to: [channel.descriptor.owner],
        createdAt: now,
        classification: 'internal',
        body: { resource: `inline:channel:${communityId}`, classification: 'internal', updatedAt: now },
        bodyHash: await sha256Hex32(new TextEncoder().encode(bodyText)),
        bodyContentType: 'text/plain',
        contextRefs: channel.descriptor.contextRefs,
      };
      const errors = validateMessageEnvelope(envelope);
      if (errors.length > 0) return jsonCors({ error: `invalid post: ${errors.join(', ')}` }, request, 400);

      // Audit-before-commit to the community's audit log (spec 291 discipline).
      await homeAuditSink(env.AUTH_CODES, `community:${communityId}`).write({
        id: globalThis.crypto.randomUUID(),
        timestamp: now,
        action: 'messaging.deliver.accept',
        outcome: 'success',
        actor: { type: 'user', id: person },
        subject: { type: 'channel-post', id: envelope.id },
      });
      channel.messages.push({ envelope, bodyText, authorName });
      // Bounded history for the demo store (KV doc, newest kept).
      if (channel.messages.length > 200) channel.messages.splice(0, channel.messages.length - 200);
      await env.AUTH_CODES.put(CHANNELS_KEY(communityId), JSON.stringify(channels));
      return jsonCors({ ok: true, messageId: envelope.id }, request);
    }

    return jsonCors({ error: 'unknown action' }, request, 400);
  } catch (e) {
    return jsonCors({ error: e instanceof Error ? e.message : String(e) }, request, 409);
  }
};
