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
import { importJwks, verifyAgentSession, verifyIdToken } from '@agenticprimitives/connect';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import type { InteractionMandateV1, InteractionTransitionType } from '@agenticprimitives/fabric/interactions';
import type { Address, Hex } from '@agenticprimitives/types';
import { getServer, resolveOrigin, ownIssuer, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
// Curated white-label entries AND member-registered ones (server/_lib/oidc-registry.ts).
import { resolveClient } from '../_lib/oidc-registry';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { readInboxView, readMessagesByContext, applyMessageAction, applyCaseTransition, applyApproveWithMandate, readCaseDetermination } from '../../src/home/inbox-data';
import { makeBodyStoreFactory } from './message-body-store';
// spec 341 §1 — the org's stewardship delegation is what lets a steward reach its inbox without a secret.
import { stewardWireFor } from './channels';
import { InboxReadError, makeInboxKv, type InboxKV } from '../lib/inbox-store';
import { mandateDigest } from '../../src/home/mandate';
import { appendControlEvent } from './control-events';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { agentNameForLabel } from '../../src/lib/domain';
import type { ContextRefV1 } from '@agenticprimitives/fabric/messaging';
import type { OrgApplication } from '../lib/org-applications';

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
  if (v.ok) return (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
  // Relying-app path (spec: messaging-from-relying-app): a registered client (e.g. the uupg tracker) drives
  // the signed-in person's inbox with the OIDC id_token it received at connect — a Home-signed, aud-scoped,
  // exp-bound assertion of "this person authenticated via <client>". We verify it against OUR OWN JWKS
  // (same keys as sessions), pin iss=self, and require aud ∈ the registered relying clients. The subject is
  // the person SA. Org inboxes stay gated by resolveInboxOwner's on-chain relationships-doc steward check,
  // so an id_token only ever reaches the person's own inbox + orgs they actually steward. No new grant is
  // needed: the interactions plane was provisioned at onboarding/org-create.
  const idv = await verifyIdTokenForRelyingClient(env, token, keys, ownIssuer(request, env));
  return idv;
}

/** Verify `token` as an id_token this Home minted for a REGISTERED relying client. The SIGNATURE is checked
 *  against our own JWKS (the real proof it's ours); iss is gated by the same `ownIssuer` predicate the
 *  session path uses (accepts apex/www/subdomain forms); aud must be a registered client_id. Returns the
 *  subject SA (lowercased) or null. */
async function verifyIdTokenForRelyingClient(
  // `env` reaches the CLIENT REGISTRY — curated entries plus the member-registered ones, which
  // live in KV and therefore need the binding rather than a compiled-in table.
  env: FnContext['env'],
  token: string,
  keys: Awaited<ReturnType<typeof importJwks>>,
  isOwnIss: (iss: string) => boolean,
): Promise<string | null> {
  // Peek the unverified iss + aud, gate them cheaply, THEN verify (signature/iss/aud/exp) against exactly
  // those values. verifyIdToken's iss/aud checks are strict-equality, so we pass the peeked values — the
  // signature check against our JWKS is what actually authenticates; the gates constrain what we accept.
  let iss: string | undefined, aud: string | undefined;
  try {
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))) as { iss?: string; aud?: string };
    iss = typeof payload.iss === 'string' ? payload.iss : undefined;
    aud = typeof payload.aud === 'string' ? payload.aud : undefined;
  } catch { return null; }
  if (!iss || !isOwnIss(iss) || !aud || !(await resolveClient(env, aud))) return null;
  const r = await verifyIdToken(token, { keys, expectedIss: iss, expectedAud: aud });
  if (!r.ok) return null;
  const sub = (r.claims.canonical_agent_id ?? r.claims.sub ?? '') as string;
  return (sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
}

/** Reverse-resolve counterparty SAs → names for display, KV-cached (10 min).
 *  One mechanism (reverseResolve, ADR-0013) — the cache holds the canonical
 *  answer; unnamed agents cache as '' and the UI falls back to the address. */
async function displayNames(env: FnContext['env'], addrs: Set<string>): Promise<Record<string, string>> {
  const naming = new AgentNamingClient({
    rpcUrl: (env.RPC_URL || DEFAULT_RPC_URL),
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
  bearer: string,
): Promise<string | null> {
  if (!requested) return person;
  const target = requested.toLowerCase();
  if (target === person.toLowerCase()) return person;
  // spec 323 W1-tail — AUTHORITATIVE: the person's vault relationships.data. A steward/managed
  // (non-'member') entry confers inbox control; a 'member' link is authority-only (channels +
  // switcher, ADR-0025) and never does. Fall to the KV projection only when the doc isn't reachable
  // (pre-enable / transient) — cache-first, not a second mechanism (ADR-0013).
  const { readRelationshipsDoc } = await import('../lib/relationships-doc');
  const doc = await readRelationshipsDoc(env, person, bearer);
  const entry = doc?.orgs?.[target];
  if (entry) return entry.relationship === 'member' ? null : target;
  const idx = JSON.parse((await env.AUTH_CODES.get(`related-idx:${person}`)) ?? '[]') as string[];
  if (!idx.some((a) => a.toLowerCase() === target)) return null;
  const raw = await env.AUTH_CODES.get(`related:${person}:${target}`);
  const link = raw ? (JSON.parse(raw) as { relationship?: string }) : null;
  return link?.relationship === 'member' ? null : target;
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  const url = new URL(request.url);
  // `?agent=<sa>` scopes the read to a managed org/service inbox the person controls (else 403).
  const bearer = (request.headers.get('authorization') ?? '').slice(7);
  const owner = await resolveInboxOwner(env, person, url.searchParams.get('agent'), bearer);
  if (!owner) return jsonCors({ error: 'not authorized for that agent inbox' }, request, 403);
  // ?contextKind=…[&contextId=…] → related-messages view (spec 312 §8.2) —
  // the same projection the inbox renders, filtered; never a second index.
  // spec 341 §1 — the person's own inbox rides their session; an ORG's rides the same session plus the
  // org's stewardship delegation, which is what proves this person may act for it. Neither is the
  // shared secret. Decided on WHO, before the call (ADR-0013).
  const self = owner.toLowerCase() === person.toLowerCase();
  const stewardWire = self ? undefined : await stewardWireFor(env, person.toLowerCase(), owner.toLowerCase(), bearer).catch(() => null);
  const inboxKv = await makeInboxKv(env, owner, bearer, stewardWire ?? undefined);
  const contextKind = url.searchParams.get('contextKind');
  if (contextKind) {
    try {
      const items = await readMessagesByContext(inboxKv, owner, {
        kind: contextKind,
        id: url.searchParams.get('contextId') ?? undefined,
      });
      return jsonCors({ items }, request);
    } catch (e) {
      if (e instanceof InboxReadError) return jsonCors({ error: e.message, code: e.code }, request, e.status);
      throw e;
    }
  }
  // VL-W4 — metadata-first: the list/poll resolves NO bodies (zero KMS decrypts → sub-second first paint);
  // a thread hydrate (?conversationId=…) resolves ONLY that conversation's bodies. The rail renders from
  // metadata (subject/sender/time); the open thread lazily fetches its own bodies.
  // `?preview=1` opts into resolving ALL bodies for the list (so a client can show a last-message
  // snippet per conversation) — heavier (one vault read per message), so it stays OFF by default and
  // the portal keeps its metadata-first fast paint. A thread hydrate (?conversationId) is unaffected.
  // `?messageIds=a,b,c` resolves exactly those bodies (capped) — the rail's last-message previews, one
  // per DM bucket, fetched once when a bucket's newest message changes rather than on every poll.
  const wantConversationId = url.searchParams.get('conversationId') ?? undefined;
  const wantMessageIds = (url.searchParams.get('messageIds') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
  const wantPreview = url.searchParams.get('preview') === '1';
  const bodyStore = wantConversationId || wantMessageIds.length > 0 || wantPreview
    ? await makeBodyStoreFactory(env, bearer, stewardWire ?? undefined)(owner)
    : undefined;
  let view;
  try {
    view = await readInboxView(
      inboxKv,
      owner,
      bodyStore,
      wantConversationId ? { conversationId: wantConversationId } : wantMessageIds.length > 0 ? { messageIds: new Set(wantMessageIds) } : undefined,
    );
  } catch (e) {
    if (e instanceof InboxReadError) return jsonCors({ error: e.message, code: e.code }, request, e.status);
    throw e;
  }
  // Counterparty display names: every sender + every conversation participant + every DM counterparty.
  const addrs = new Set<string>();
  for (const m of Object.values(view.envelopeMeta)) {
    const a = m.from.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase();
    if (a && a !== owner) addrs.add(a);
  }
  for (const dm of view.directMessages) for (const a of dm.counterparties) addrs.add(a);
  for (const d of Object.values(view.descriptors)) {
    for (const p of d.participants) {
      const a = p.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase();
      if (a && a !== owner) addrs.add(a);
    }
    // Context orgs too — the Join chips label themselves with the ORG's name (two invites in one
    // thread were indistinguishable as generic "Join the organization" chips).
    for (const r of d.contextRefs ?? []) {
      const a = r.id.match(/^0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase();
      if (a) addrs.add(a);
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
        /** Direct recipient Smart Agent (0x…). Preferred for org-roster messaging when the peer
         *  has no public naming claim — canonical identity is the SA (ADR-0041). */
        to?: string;
        subject?: string;
        bodyText?: string;
        contextRefs?: ContextRefV1[];
        conversationId?: string;
        /** Optional managed org/service SA to act as — the person must control it (else 403). */
        agent?: string;
        /** action:'apply' — the organization SA the applicant is requesting to join (spec 324 §7). */
        org?: string;
      }
    | null;

  // Scope the action to the person's own inbox, or a managed org/service inbox they control.
  const bearerP = (request.headers.get('authorization') ?? '').slice(7);
  const owner = await resolveInboxOwner(env, person, body?.agent, bearerP);
  if (!owner) return jsonCors({ error: 'not authorized for that agent inbox' }, request, 403);

  // The inbox is vault-resident (spec 316 §11a): each owner's `inbox.data` lives in their MCP vault.
  const inboxKvFor = async (o: string): Promise<InboxKV> => {
    const isSelf = o.toLowerCase() === person.toLowerCase();
    const wire = isSelf ? undefined : await stewardWireFor(env, person.toLowerCase(), o.toLowerCase(), bearerP).catch(() => null);
    return makeInboxKv(env, o, bearerP, wire ?? undefined);
  };
  const inboxKv = await inboxKvFor(owner);

  try {
    // `action:'send'` and `action:'reply'` are GONE (spec 341 §5.1c). Sending is now an authorized A2A
    // delivery performed by the sender's OWN agent — person or organization — and the browser drives it
    // directly. Nothing here writes into a recipient's vault any more, which is what this route did:
    // it composed as the sender and wrote both copies over a standing grant and a shared secret.
    //
    // Recipient RESOLUTION moved with it. The agent resolves a claimed name on-chain, because it is the
    // party that must also decide whether its wire covers the result — resolving in one place and
    // authorizing in another is how you get a send addressed to someone the grant never named.
    if (body?.action === 'apply') {
      // spec 324 §7 Tier-2 — submit a MembershipApplication into the ORG's `org.applications` vault doc (a plain
      // whole-doc record via the org's InteractionsDO — NOT the inbox, so it surfaces reliably to the steward).
      // NOT membership-gated (a non-member applies). Approval (steward, /connect/org-decide) creates the
      // OrganizationMembership; this record confers NOTHING (ADR-0041/0048 #8). One entry per applicant (re-apply
      // updates in place).
      const orgSa = (body.org ?? '').trim().toLowerCase();
      if (!/^0x[0-9a-fA-F]{40}$/.test(orgSa)) return jsonCors({ error: 'org (SA) required' }, request, 400);
      if (orgSa === owner.toLowerCase()) return jsonCors({ error: 'cannot apply to your own agent' }, request, 400);
      // spec 341 §5.5a — ADMISSION, not a write. The Home used to read the org's applications doc,
      // append, and write it back over the shared secret: a stranger's submission performed with an
      // authority that could have edited anything in that org. Now the applicant's OWN agent sends
      // `org.apply` to the org's agent, and the ORG's own grant does the writing after its gate
      // admits. Nothing the applicant presents carries write authority.
      //
      // The Home relays the intent to the applicant's agent; it holds no authority over either party.
      const { callInteractions } = await import('./channels');
      const r = await callInteractions(env, owner, 'messaging.send', {
        session: bearerP,
        recipient: orgSa,
        skill: 'org.apply',
        applicationMessage: body.bodyText?.trim() || 'Requesting to join this organization.',
      });
      // A `wire_absent` / `recipient_not_in_wire` refusal is passed through verbatim: applying needs
      // the same one-time approval sending does, and the person resolves it at their Home.
      if (r.status >= 400 || r.body.ok === false) {
        // FORWARD THE WIRE FIELDS, not just the message. `wire_absent` is not a dead end — it is a
        // request for the one-prompt approval — but the client can only OFFER that ceremony if it is
        // told which recipient needs approving, which counterparties the current wire already covers,
        // and which session key every wire must name. Dropping them turned a resolvable refusal into an
        // error string, which is how applying to an organization became a button that does nothing.
        return jsonCors(
          {
            error: r.body.error ?? 'apply failed',
            code: r.body.code,
            ...(r.body.recipient ? { recipient: r.body.recipient } : {}),
            ...(Array.isArray(r.body.recipients) ? { recipients: r.body.recipients } : {}),
            ...(r.body.sessionKey ? { sessionKey: r.body.sessionKey } : {}),
          },
          request,
          r.status >= 400 ? r.status : 502,
        );
      }
      return jsonCors({ ok: true, applicationId: r.body.messageId ?? null }, request);
    }
    if (body?.action === 'read' || body?.action === 'archive') {
      if (!body.messageId) return jsonCors({ error: 'messageId required' }, request, 400);
      await applyMessageAction(inboxKv, owner as Address, body.messageId, body.action === 'read' ? 'read' : 'archived');
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
          rpcUrl: (env.RPC_URL || DEFAULT_RPC_URL),
          chainId: CHAIN_ID,
          entryPoint: CONTRACTS.entryPoint,
          factory: CONTRACTS.agentAccountFactory,
        });
        const updated = await applyApproveWithMandate(
          inboxKv,
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
        ], bearerP);
        return jsonCors({ ok: true, case: updated }, request);
      }

      const updated = await applyCaseTransition(inboxKv, owner as Address, body.interactionId, transition, body.reason);
      // Decisions land on the control-plane timeline (spec 310 W4); view/triage
      // are navigation, not decisions.
      if (transition === 'approve' || transition === 'deny' || transition === 'ask-info' || transition === 'revoke') {
        await appendControlEvent(env, owner as Address, 'inbox-decision', updated.authorityRefs.slice(-1), bearerP);
      }
      // spec 340 W10b-2: return what was DETERMINED alongside how far the work got. The client no
      // longer has to read a determination out of `case.state` — which is the reading that made one
      // field answer three questions with three different signers (spec 340 §R.2).
      const determination = await readCaseDetermination(inboxKv, owner as Address, body.interactionId);
      return jsonCors({ ok: true, case: updated, ...determination }, request);
    }
    return jsonCors({ error: 'unknown action' }, request, 400);
  } catch (e) {
    if (e instanceof InboxReadError) return jsonCors({ error: e.message, code: e.code }, request, e.status);
    return jsonCors({ error: e instanceof Error ? e.message : String(e) }, request, 409);
  }
};
