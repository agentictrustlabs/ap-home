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
import type { InteractionMandateV1, InteractionTransitionType } from '@agenticprimitives/fabric/interactions';
import type { Address, Hex } from '@agenticprimitives/types';
import { getServer, resolveOrigin, ownIssuer, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { readInboxView, readMessagesByContext, applyMessageAction, applyCaseTransition, applyApproveWithMandate, sendFromInbox, replyInConversation } from '../../src/home/inbox-data';
import { makeBodyStoreFactory } from './message-body-store';
import { mandateDigest } from '../../src/home/mandate';
import { appendControlEvent } from './control-events';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { agentNameForLabel } from '../../src/lib/domain';
import type { ContextRefV1 } from '@agenticprimitives/fabric/messaging';

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
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return null;
  return (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
}

/** Reverse-resolve counterparty SAs → names for display, KV-cached (10 min).
 *  One mechanism (reverseResolve, ADR-0013) — the cache holds the canonical
 *  answer; unnamed agents cache as '' and the UI falls back to the address. */
async function displayNames(env: FnContext['env'], addrs: Set<string>): Promise<Record<string, string>> {
  const naming = new AgentNamingClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
    chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry,
    universalResolver: CONTRACTS.agentNameUniversalResolver,
  });
  const out: Record<string, string> = {};
  await Promise.all(
    [...addrs].slice(0, 50).map(async (addr) => {
      const key = `namecache:${addr}`;
      const cached = await env.AUTH_CODES.get(key);
      if (cached !== null) {
        if (cached) out[addr] = cached;
        return;
      }
      const name = (await naming.reverseResolve(addr as Address).catch(() => null)) ?? '';
      await env.AUTH_CODES.put(key, name, { expirationTtl: 600 });
      if (name) out[addr] = name;
    }),
  );
  return out;
}

/**
 * Resolve which inbox to act on. Default = the session person's OWN inbox. When `?agent=<sa>` (GET) or
 * `body.agent` (POST) names a managed org/service SA, the person may act on THAT agent's inbox ONLY if they
 * control it — i.e. it is in their managed-agents set (`related-idx:<person>`, the same control set the
 * workspace switcher gates org/service access on, spec 315 / ADR-0025). Fail-closed: an uncontrolled agent
 * → `null` (the caller returns 403). Each inbox is keyed by SA (`inbox-data:<sa>`), so this simply chooses
 * which SA's inbox the person is authorized to read/act on.
 */
async function resolveInboxOwner(
  env: FnContext['env'],
  person: string,
  requested: string | null | undefined,
): Promise<string | null> {
  if (!requested) return person;
  const target = requested.toLowerCase();
  if (target === person.toLowerCase()) return person;
  const idx = JSON.parse((await env.AUTH_CODES.get(`related-idx:${person}`)) ?? '[]') as string[];
  if (!idx.some((a) => a.toLowerCase() === target)) return null;
  // spec 318: a relationship:'member' link is AUTHORITY-ONLY (channels + switcher) — it never
  // confers control of the agent's inbox. Legacy/steward links keep control.
  const raw = await env.AUTH_CODES.get(`related:${person}:${target}`);
  const link = raw ? (JSON.parse(raw) as { relationship?: string }) : null;
  return link?.relationship === 'member' ? null : target;
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  const url = new URL(request.url);
  // `?agent=<sa>` scopes the read to a managed org/service inbox the person controls (else 403).
  const owner = await resolveInboxOwner(env, person, url.searchParams.get('agent'));
  if (!owner) return jsonCors({ error: 'not authorized for that agent inbox' }, request, 403);
  // ?contextKind=…[&contextId=…] → related-messages view (spec 312 §8.2) —
  // the same projection the inbox renders, filtered; never a second index.
  const contextKind = url.searchParams.get('contextKind');
  if (contextKind) {
    const items = await readMessagesByContext(env.AUTH_CODES, owner, {
      kind: contextKind,
      id: url.searchParams.get('contextId') ?? undefined,
    });
    return jsonCors({ items }, request);
  }
  const view = await readInboxView(env.AUTH_CODES, owner, await makeBodyStoreFactory(env)(owner));
  // Counterparty display names: every sender + every conversation participant.
  const addrs = new Set<string>();
  for (const m of Object.values(view.envelopeMeta)) {
    const a = m.from.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase();
    if (a && a !== owner) addrs.add(a);
  }
  for (const d of Object.values(view.descriptors)) {
    for (const p of d.participants) {
      const a = p.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase();
      if (a && a !== owner) addrs.add(a);
    }
  }
  const names = await displayNames(env, addrs);
  return jsonCors({ ...view, names }, request);
};

// 13→11 reconciliation: `view` is no longer a case transition (viewing marks the inbox MESSAGE read, an
// inbox fact — not a case state). Owner review moves are triage/ask-info/approve/deny/revoke.
const OWNER_TRANSITIONS: readonly InteractionTransitionType[] = ['triage', 'ask-info', 'approve', 'deny', 'revoke'];

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);

  const body = (await request.json().catch(() => null)) as
    | {
        action?: string;
        messageId?: string;
        interactionId?: string;
        transition?: string;
        reason?: string;
        mandate?: InteractionMandateV1;
        toLabel?: string;
        toName?: string;
        subject?: string;
        bodyText?: string;
        contextRefs?: ContextRefV1[];
        conversationId?: string;
        /** Optional managed org/service SA to act as — the person must control it (else 403). */
        agent?: string;
      }
    | null;

  // Scope the action to the person's own inbox, or a managed org/service inbox they control.
  const owner = await resolveInboxOwner(env, person, body?.agent);
  if (!owner) return jsonCors({ error: 'not authorized for that agent inbox' }, request, 403);

  try {
    if (body?.action === 'send') {
      // Composer send (spec 312): recipient by claimed name — one on-chain
      // resolution mechanism; no listing/roster lookup here (ADR-0025).
      // `toName` is a FULL name (any parent, e.g. alice.demo.agent — what the
      // KB search returns); `toLabel` is a bare label under the app's default
      // parent (what directory listings store).
      const fullName = (body.toName ?? '').trim().toLowerCase();
      const label = (body.toLabel ?? '').trim().toLowerCase();
      const name = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/.test(fullName)
        ? fullName
        : /^[a-z0-9-]{1,63}$/.test(label)
          ? agentNameForLabel(label)
          : null;
      if (!name || !body.bodyText?.trim()) {
        return jsonCors({ error: 'toName (full) or toLabel + bodyText required' }, request, 400);
      }
      const naming = new AgentNamingClient({
        rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL,
        chainId: CHAIN_ID,
        registry: CONTRACTS.agentNameRegistry,
        universalResolver: CONTRACTS.agentNameUniversalResolver,
      });
      const recipient = await naming.resolveName(name);
      if (!recipient) return jsonCors({ error: `no agent claimed the name "${name}"` }, request, 404);
      const out = await sendFromInbox(env.AUTH_CODES, owner as Address, {
        recipient,
        subject: body.subject,
        bodyText: body.bodyText,
        contextRefs: body.contextRefs,
        conversationId: body.conversationId,
      }, makeBodyStoreFactory(env));
      return jsonCors({ ok: true, ...out }, request);
    }
    if (body?.action === 'reply') {
      // In-thread chat reply (spec 313): recipient comes from the owner's own
      // conversation descriptor — never the wire.
      if (!body.conversationId || !body.bodyText?.trim()) {
        return jsonCors({ error: 'conversationId + bodyText required' }, request, 400);
      }
      const out = await replyInConversation(env.AUTH_CODES, owner as Address, body.conversationId, body.bodyText, makeBodyStoreFactory(env));
      return jsonCors({ ok: true, ...out }, request);
    }
    if (body?.action === 'read' || body?.action === 'archive') {
      if (!body.messageId) return jsonCors({ error: 'messageId required' }, request, 400);
      await applyMessageAction(env.AUTH_CODES, owner as Address, body.messageId, body.action === 'read' ? 'read' : 'archived');
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
          owner as Address,
          body.interactionId,
          body.mandate,
          async (digest, signature) => {
            try {
              return await accounts.isValidSignature(owner as Address, digest, signature as Hex);
            } catch {
              return false;
            }
          },
          mandateDigest,
        );
        // The mandate (scoped delegation + signed intent) is the issued artifact.
        await appendControlEvent(env, owner as Address, 'credential-issued', [
          { kind: 'delegation', hash: body.mandate.delegationHash },
        ]);
        return jsonCors({ ok: true, case: updated }, request);
      }

      const updated = await applyCaseTransition(env.AUTH_CODES, owner as Address, body.interactionId, transition, body.reason);
      // Decisions land on the control-plane timeline (spec 310 W4); view/triage
      // are navigation, not decisions.
      if (transition === 'approve' || transition === 'deny' || transition === 'ask-info' || transition === 'revoke') {
        await appendControlEvent(env, owner as Address, 'inbox-decision', updated.authorityRefs.slice(-1));
      }
      return jsonCors({ ok: true, case: updated }, request);
    }
    return jsonCors({ error: 'unknown action' }, request, 400);
  } catch (e) {
    return jsonCors({ error: e instanceof Error ? e.message : String(e) }, request, 409);
  }
};
